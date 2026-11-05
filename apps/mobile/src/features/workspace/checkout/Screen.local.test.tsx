const mockCheckoutDispatch = jest.fn();
jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: jest.fn(),
  useNavigation: () => ({ dispatch: mockCheckoutDispatch }),
}));
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
import { usePreventRemove } from 'expo-router/react-navigation';
import { router } from 'expo-router';
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
import { gitCheckoutCloningAtom, gitCheckoutParentPathAtom } from '../state/gitCheckout';
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

  it('admits a rapid duplicate submit only once and stays locked until settlement', async () => {
    const port = new FakeAgentPort();
    const cloneNormally = port.workspaceAdmin.clone.bind(port.workspaceAdmin);
    let releaseClone!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    let admissions = 0;
    port.workspaceAdmin.clone = async (...args) => {
      admissions += 1;
      if (admissions > 1) {
        throw new Error('Clone already active');
      }
      await gate;
      return cloneNormally(...args);
    };
    const { root, store } = await renderLocalCheckout(port);
    const previousCwd = store.get(defaultStartCwdAtom);
    await invoke(
      labeled(root, 'Repository URL'),
      'onChangeText',
      'https://github.com/acme/tool.git',
    );
    const submit = labeled(root, 'Clone repository').props['onPress'] as () => void;
    await act(async () => {
      submit();
      submit();
      await flush();
    });
    const hasLabel = (label: string) =>
      root.findAll((node) => node.props['accessibilityLabel'] === label).length > 0;
    const leafAlerts = () =>
      root.findAll(
        (node) =>
          node.props['accessibilityRole'] === 'alert' &&
          node.children.every((child) => typeof child === 'string'),
      );
    try {
      expect({
        admissions,
        cloning: store.get(gitCheckoutCloningAtom),
        cloneDisabled: labeled(root, 'Clone repository').props['disabled'],
        backDisabled: labeled(root, 'Back').props['disabled'],
        urlEditable: labeled(root, 'Repository URL').props['editable'],
        nameEditable: labeled(root, 'Workspace name').props['editable'],
        stopPresent: hasLabel('Stop cloning'),
        spinnerPresent: hasLabel('Cloning repository'),
        alerts: leafAlerts().length,
        cwd: store.get(defaultStartCwdAtom),
      }).toEqual({
        admissions: 1,
        cloning: true,
        cloneDisabled: true,
        backDisabled: true,
        urlEditable: false,
        nameEditable: false,
        stopPresent: true,
        spinnerPresent: true,
        alerts: 0,
        cwd: previousCwd,
      });
      expect(usePreventRemove).toHaveBeenLastCalledWith(true, expect.any(Function));
    } finally {
      await act(async () => {
        releaseClone();
        await flush();
      });
    }
    expect(admissions).toBe(1);
    expect(store.get(gitCheckoutCloningAtom)).toBe(false);
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/tool`);
    expect(labeled(root, 'Clone repository').props['disabled']).toBe(false);
    expect(labeled(root, 'Back').props['disabled']).toBe(false);
    expect(labeled(root, 'Cancel git checkout').props['disabled']).toBe(false);
    expect(labeled(root, 'Repository URL').props['editable']).toBe(true);
    expect(labeled(root, 'Workspace name').props['editable']).toBe(true);
    expect(hasLabel('Stop cloning')).toBe(false);
    expect(hasLabel('Cloning repository')).toBe(false);
    expect(leafAlerts()).toHaveLength(0);
    expect(usePreventRemove).toHaveBeenLastCalledWith(false, expect.any(Function));
  });

  it('allows its completed clone navigation even before the previous removal guard rerenders', async () => {
    mockCheckoutDispatch.mockClear();
    const port = new FakeAgentPort();
    const normalClone = port.workspaceAdmin.clone.bind(port.workspaceAdmin);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    port.workspaceAdmin.clone = async (...args) => {
      await pending;
      return normalClone(...args);
    };
    const { root, store } = await renderLocalCheckout(port);
    await invoke(
      labeled(root, 'Repository URL'),
      'onChangeText',
      'https://github.com/acme/tool.git',
    );
    await invoke(labeled(root, 'Clone repository'));
    const previousGuard = jest
      .mocked(usePreventRemove)
      .mock.calls.filter(([blocked]) => blocked)
      .at(-1)?.[1];
    if (!previousGuard) {
      throw new Error('Expected the active clone to prevent removal.');
    }
    const action = { type: 'GO_BACK' };
    previousGuard({ data: { action } });
    expect(mockCheckoutDispatch).not.toHaveBeenCalled();
    const cloningAtNavigation: boolean[] = [];
    jest.mocked(router.dismissTo).mockImplementationOnce(() => {
      cloningAtNavigation.push(store.get(gitCheckoutCloningAtom));
      previousGuard({ data: { action } });
    });
    await act(async () => {
      finish();
      await flush();
    });
    expect(cloningAtNavigation).toEqual([false]);
    expect(mockCheckoutDispatch).toHaveBeenCalledWith(action);
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/tool`);
    expect(store.get(gitCheckoutCloningAtom)).toBe(false);
  });

  it('settles a stopped clone and allows retry without losing the form', async () => {
    const port = new FakeAgentPort();
    const cloneNormally = port.workspaceAdmin.clone.bind(port.workspaceAdmin);
    let rejectClone!: (reason: Error) => void;
    const interruptedClone = new Promise<Awaited<ReturnType<typeof cloneNormally>>>((_, reject) => {
      rejectClone = reject;
    });
    let attempts = 0;
    port.workspaceAdmin.clone = (...args) =>
      attempts++ === 0 ? interruptedClone : cloneNormally(...args);
    const { root, store } = await renderLocalCheckout(port);
    const previousCwd = store.get(defaultStartCwdAtom);
    const url = 'https://github.com/acme/tool.git';
    await invoke(labeled(root, 'Repository URL'), 'onChangeText', url);
    await invoke(labeled(root, 'Clone repository'));
    expect(labeled(root, 'Clone repository').props['disabled']).toBe(true);
    expect(labeled(root, 'Back').props['disabled']).toBe(true);
    for (const label of ['Repository URL', 'Workspace name']) {
      expect(labeled(root, label).props['editable']).toBe(false);
    }
    await invoke(labeled(root, 'Stop cloning'));
    expect(port.calls).toContain('workspace.cancelTransfer');
    await act(async () => {
      rejectClone(new Error('Clone cancelled'));
      await flush();
    });
    expect(
      root.findAll((node) =>
        ['Stop cloning', 'Cloning repository'].includes(node.props['accessibilityLabel'] as string),
      ),
    ).toHaveLength(0);
    expect(root.findAll((node) => node.props['accessibilityRole'] === 'progressbar')).toHaveLength(
      0,
    );
    expect(
      root.findAll(
        (node) =>
          node.props['accessibilityRole'] === 'alert' &&
          node.children.every((child) => typeof child === 'string'),
      ),
    ).toHaveLength(1);
    expect(labeled(root, 'Clone repository').props['disabled']).toBe(false);
    expect(labeled(root, 'Cancel git checkout').props['disabled']).toBe(false);
    expect(labeled(root, 'Back').props['disabled']).toBe(false);
    expect(labeled(root, 'Repository URL').props['value']).toBe(url);
    expect(labeled(root, 'Workspace name').props['value']).toBe('tool');
    for (const label of ['Repository URL', 'Workspace name']) {
      expect(labeled(root, label).props['editable']).toBe(true);
    }
    expect(store.get(defaultStartCwdAtom)).toBe(previousCwd);
    await invoke(labeled(root, 'Clone repository'));
    expect(attempts).toBe(2);
    expect(store.get(defaultStartCwdAtom)).toBe(`${LOCAL_WORKSPACE_ROOT}/tool`);
    expect(root.findAll((node) => node.props['accessibilityRole'] === 'alert')).toHaveLength(0);
  });

  it('follows native clone progress events with one snapshot read and no polling', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      const port = new FakeAgentPort();
      let finish: (workspace: LocalWorkspace) => void = () => undefined;
      port.workspaceAdmin.clone = () =>
        new Promise<LocalWorkspace>((resolve) => {
          finish = resolve;
        });
      let snapshotReads = 0;
      port.workspaceAdmin.cloneProgress = () => {
        snapshotReads += 1;
        return { active: true, cancelled: false, completed: 0, total: 0 };
      };
      const { root } = await renderLocalCheckout(port);
      await invoke(
        labeled(root, 'Repository URL'),
        'onChangeText',
        'https://github.com/acme/tool.git',
      );
      await invoke(labeled(root, 'Clone repository'));

      expect(text(root)).toContain('Connecting to the remote…');
      expect(snapshotReads).toBe(1);
      expect(port.cloneProgressListeners.size).toBe(1);

      await act(async () => {
        port.emitCloneProgress({ active: true, cancelled: false, completed: 90, total: 120 });
        await flush();
      });
      expect(text(root)).toContain('Receiving files: 90 of 120');
      const bar = root.findAll(
        (node) =>
          node.props['accessibilityRole'] === 'progressbar' &&
          (node.props['accessibilityValue'] as { now?: number } | undefined)?.now === 75,
      );
      expect(bar.length).toBeGreaterThan(0);

      await act(async () => {
        jest.advanceTimersByTime(5_000);
        await flush();
      });
      expect(snapshotReads).toBe(1);

      await act(async () => {
        port.emitCloneProgress({ active: true, cancelled: true, completed: 90, total: 120 });
        await flush();
      });
      expect(text(root)).toContain('Stopping…');

      await act(async () => {
        finish({ id: 'ws-tool', name: 'tool', isRepository: true });
        await flush();
      });
      expect(text(root)).not.toContain('Receiving files');
      expect(text(root)).not.toContain('Stopping…');
      expect(snapshotReads).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a newer progress event over a slower snapshot read', async () => {
    const port = new FakeAgentPort();
    let finish: (workspace: LocalWorkspace) => void = () => undefined;
    port.workspaceAdmin.clone = () =>
      new Promise<LocalWorkspace>((resolve) => {
        finish = resolve;
      });
    port.workspaceAdmin.cloneProgress = () => {
      port.emitCloneProgress({ active: true, cancelled: false, completed: 60, total: 120 });
      return { active: true, cancelled: false, completed: 10, total: 120 };
    };
    const { root } = await renderLocalCheckout(port);
    await invoke(
      labeled(root, 'Repository URL'),
      'onChangeText',
      'https://github.com/acme/tool.git',
    );
    await invoke(labeled(root, 'Clone repository'));

    expect(text(root)).toContain('Receiving files: 60 of 120');
    expect(text(root)).not.toContain('Receiving files: 10 of 120');

    await act(async () => {
      finish({ id: 'ws-tool', name: 'tool', isRepository: true });
      await flush();
    });
    await act(async () => {
      port.emitCloneProgress({ active: true, cancelled: false, completed: 90, total: 120 });
      await flush();
    });
    expect(text(root)).not.toContain('Receiving files');
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
