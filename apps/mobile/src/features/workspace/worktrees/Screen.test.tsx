jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000002' }));

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import type { HostBridgeApiClient } from '@bridge/client/client';
import type { ManagedWorktree } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { createTestStore, withAppStore } from '@shell/state/testing';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { WorktreesForm } from './Screen';

type TestNode = {
  props: {
    accessibilityLabel?: string;
    disabled?: boolean;
    editable?: boolean;
    onPress: () => void;
    onChangeText: (value: string) => void;
  };
  type: unknown;
  children: unknown[];
  findAll: (predicate: (node: TestNode) => boolean) => TestNode[];
};
const renderedText = (tree: ReactTestRenderer) =>
  (tree.root as unknown as TestNode)
    .findAll((node) => typeof node.type === 'string')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string'))
    .join(' ');

const worktree: ManagedWorktree = {
  id: '00000000-0000-4000-8000-000000000002',
  repository: '/repo',
  path: '/data/worktrees/task',
  branch: 'feature/task',
  baseRef: 'HEAD',
  baseCommit: 'abc',
  status: 'ready',
};
const theme = createAppTheme('dark');
function mockApi() {
  return {
    readBridgeCapabilities: jest.fn().mockResolvedValue({ supports: { managedWorktrees: true } }),
    listManagedWorktrees: jest.fn().mockResolvedValue({ worktrees: [] }),
    createManagedWorktree: jest.fn().mockResolvedValue({ worktree }),
    removeManagedWorktree: jest.fn().mockResolvedValue({ removed: true }),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function render(api: ReturnType<typeof mockApi>, connected = true) {
  const store = createTestStore();
  let tree!: ReactTestRenderer;
  const content = (isConnected: boolean) =>
    withAppStore(
      store,
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, bottom: 34, left: 0, right: 0 },
        }}
      >
        <AppThemeProvider theme={theme}>
          <WorktreesForm
            api={api as unknown as HostBridgeApiClient}
            cwd="/repo"
            profileId="profile"
            connected={isConnected}
          />
        </AppThemeProvider>
      </SafeAreaProvider>,
    );
  await act(async () => {
    tree = renderer.create(content(connected));
  });
  const button = (label: string) =>
    (tree.root as unknown as TestNode).findAll(
      (node) => node.props.accessibilityLabel === label,
    )[0]!;
  const input = (label: string) =>
    (tree.root as unknown as TestNode).findAll(
      (node) => node.props.accessibilityLabel === label,
    )[0]!;
  return { tree, store, button, input, reconnect: () => tree.update(content(true)) };
}

describe('managed worktree workflow', () => {
  beforeEach(() => jest.clearAllMocks());
  it('waits for the bridge on cold navigation and loads when the socket connects', async () => {
    const api = mockApi();
    const { tree, button, reconnect } = await render(api, false);
    expect(api.readBridgeCapabilities).not.toHaveBeenCalled();
    expect(button('Create worktree').props.disabled).toBe(true);
    expect(renderedText(tree)).not.toContain('Unable to connect');
    await act(async () => {
      reconnect();
    });
    expect(api.readBridgeCapabilities).toHaveBeenCalledTimes(1);
    expect(api.listManagedWorktrees).toHaveBeenCalledTimes(1);
    expect(renderedText(tree)).toContain('No managed worktrees yet.');
    act(() => tree.unmount());
  });
  it('settles a failed create, retries the same request, and explicitly selects the isolated checkout', async () => {
    const api = mockApi();
    const first = deferred<{ worktree: ManagedWorktree }>();
    api.createManagedWorktree.mockReturnValueOnce(first.promise);
    const { tree, store, button, input } = await render(api);
    expect(button('Create worktree').props.disabled).toBe(true);
    act(() => input('Worktree branch').props.onChangeText('feature/task'));
    await act(async () => {
      button('Create worktree').props.onPress();
    });
    expect(input('Worktree branch').props.editable).toBe(false);
    expect(button('Back').props.disabled).toBe(true);
    expect(button('Create worktree').props.disabled).toBe(true);
    expect(usePreventRemove).toHaveBeenLastCalledWith(true, expect.any(Function));
    await act(async () => {
      first.reject(new Error('Connection lost'));
    });
    expect(renderedText(tree)).toContain('Connection lost');
    expect(button('Back').props.disabled).toBe(false);
    expect(input('Worktree branch').props.editable).toBe(true);
    expect(button('Create worktree').props.disabled).toBe(false);
    expect(usePreventRemove).toHaveBeenLastCalledWith(false, expect.any(Function));
    await act(async () => {
      button('Create worktree').props.onPress();
    });
    expect(api.createManagedWorktree.mock.calls[1]).toEqual(
      api.createManagedWorktree.mock.calls[0],
    );
    expect(renderedText(tree)).not.toContain('Connection lost');
    expect(button('Use worktree feature/task').props.disabled).toBe(false);
    expect(store.get(defaultStartCwdAtom)).toBeNull();
    act(() => button('Use worktree feature/task').props.onPress());
    expect(store.get(defaultStartCwdAtom)).toBe(worktree.path);
    expect(router.dismissTo).toHaveBeenCalledWith({
      pathname: '/profiles/[profileId]/chats/[chatId]',
      params: { profileId: 'profile', chatId: 'new' },
    });
    act(() => tree.unmount());
  });

  it('keeps the checkout visible on a refused removal and removes it only after success', async () => {
    const api = mockApi();
    api.listManagedWorktrees.mockResolvedValue({ worktrees: [worktree] });
    const removal = deferred<{ removed: boolean }>();
    api.removeManagedWorktree.mockReturnValueOnce(removal.promise);
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) =>
        buttons?.find((button) => button.text === 'Remove')?.onPress?.(),
      );
    const { tree, button } = await render(api);
    await act(async () => {
      button('Remove worktree feature/task').props.onPress();
    });
    expect(button('Use worktree feature/task').props.disabled).toBe(true);
    await act(async () => {
      removal.reject(new Error('Delete the chats using this worktree before removing it.'));
    });
    expect(button('Use worktree feature/task').props.disabled).toBe(false);
    expect(button('Remove worktree feature/task').props.disabled).toBe(false);
    expect(renderedText(tree)).toContain('Delete the chats');
    await act(async () => {
      button('Remove worktree feature/task').props.onPress();
    });
    expect(button('Use worktree feature/task')).toBeUndefined();
    expect(renderedText(tree)).toContain('No managed worktrees yet.');
    act(() => tree.unmount());
    alert.mockRestore();
  });

  it('does not offer creation on an older bridge', async () => {
    const api = mockApi();
    api.readBridgeCapabilities.mockResolvedValue({ supports: {} });
    const { tree, button } = await render(api);
    expect(api.listManagedWorktrees).not.toHaveBeenCalled();
    expect(button('Create worktree').props.disabled).toBe(true);
    expect(renderedText(tree)).toContain('Update the desktop app');
    act(() => tree.unmount());
  });
});
