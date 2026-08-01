import { Switch } from 'react-native';
jest.mock('expo-router', () => jest.requireActual('../../testing/expoRouterMock'));
import { router } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '../../api/client';
import type { BridgeCapabilities } from '../../api/types';
import type { AppStateData, PushSettingsState } from '../../appState';
import { AppStatePersistenceError, createDefaultAppStateData } from '../../appState';
import type { WorkspaceChatLimit } from '../../appSettings';
import type { BridgeProfile } from '../../bridgeProfiles';
import { requestPushRegistration } from '../../pushNotifications';
import { appStateSnapshotAtom, pushSettingsAtom } from '../../state/appState/atoms';
import {
  approvalModeAtom,
  showToolCallsAtom,
  workspaceChatLimitAtom,
} from '../../state/appState/settings';
import { apiClientAtom, bridgeConnectedAtom } from '../../state/bridge/atoms';
import { drawerCommandsAtom } from '../../state/drawer/atoms';
import { createMemoryPersistence, createTestStore, withAppStore } from '../../state/testing';
import type { AppStore } from '../../state/types';
import { AppThemeProvider, createAppTheme } from '../../theme';
import { SettingsScreen } from './SettingsScreen';
import { routes } from '../../navigation/routes';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));
jest.mock('../../pushNotifications', () => ({ requestPushRegistration: jest.fn() }));
jest.mock('../../chatSnapshotCache', () => ({
  loadChatSnapshotCache: jest
    .fn()
    .mockResolvedValue({ profileId: 'profile-2', selectedChatId: null, entries: [] }),
  deleteChatSnapshotCache: jest.fn().mockResolvedValue(undefined),
  saveChatSnapshotCache: jest.fn().mockResolvedValue(undefined),
  createEmptyChatSnapshotCache: (profileId: string) => ({
    profileId,
    selectedChatId: null,
    entries: [],
  }),
  updateChatSnapshotCache: (cache: unknown) => cache,
}));

type Queryable = Omit<ReactTestInstance, 'children' | 'findAll' | 'parent' | 'props'> & {
  children: unknown[];
  props: Record<string, unknown>;
  parent: Queryable | null;
  type: unknown;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

type PressCallback = () => void;
type ToggleCallback = (value: boolean) => void;

const theme = createAppTheme('dark');
const requestRegistration = requestPushRegistration as jest.MockedFunction<
  typeof requestPushRegistration
>;
const profiles: BridgeProfile[] = [
  {
    id: 'profile-1',
    name: 'Primary',
    bridgeUrl: 'http://127.0.0.1:3001',
    bridgeToken: 'one',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'profile-2',
    name: 'Secondary',
    bridgeUrl: 'http://127.0.0.1:3002',
    bridgeToken: 'two',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
];
const capabilities: BridgeCapabilities = {
  protocolVersion: 2,
  streamId: 'stream-1',
  preferredAgentId: 'codex',
  activeAgentId: 'codex',
  agents: [
    {
      agentId: 'codex',
      displayName: 'Codex',
      version: '1.2.3',
      provenance: 'managed',
      lifecycle: 'ready',
      lastError: null,
    },
    {
      agentId: 'offline',
      displayName: 'Offline agent',
      version: '0.1.0',
      provenance: 'local',
      lifecycle: 'unavailable',
      lastError: 'secret detail',
    },
  ],
  supportsByAgent: {},
  agUiEvents: true,
  supports: {
    reviewStart: true,
    turnSteer: true,
    commandOutputDelta: true,
    browserPreview: true,
    genericUiSurface: true,
  },
};

interface SettingsStoreOptions {
  push?: Partial<PushSettingsState>;
  activeProfileId?: string | null;
  workspaceChatLimit?: WorkspaceChatLimit;
  persistenceError?: AppStatePersistenceError | null;
  writeCurrent?: jest.Mock;
}

function createSettingsData(options: SettingsStoreOptions): AppStateData {
  const data = createDefaultAppStateData();
  data.push = { ...data.push, ...options.push };
  data.bridgeProfiles = {
    activeProfileId: options.activeProfileId === undefined ? 'profile-1' : options.activeProfileId,
    profiles,
  };
  if (options.workspaceChatLimit !== undefined) {
    data.settings = { ...data.settings, workspaceChatLimit: options.workspaceChatLimit };
  }
  return data;
}

function createSettingsStore(options: SettingsStoreOptions = {}): AppStore {
  const persistence = createMemoryPersistence();
  if (options.writeCurrent) {
    persistence.writeCurrent = options.writeCurrent as unknown as typeof persistence.writeCurrent;
  }
  const store = createTestStore({ data: createSettingsData(options), persistence });
  if (options.persistenceError) {
    store.set(appStateSnapshotAtom, {
      ...store.get(appStateSnapshotAtom),
      persistenceError: options.persistenceError,
    });
  }
  return store;
}

function hasText(root: Queryable, text: string): boolean {
  return root.findAll((node) => node.children.map(String).join('').includes(text)).length > 0;
}

function findPressableByText(root: Queryable, text: string): Queryable {
  const textNode = root.findAll((node) => node.children.map(String).join('') === text)[0];
  let current: Queryable | null = textNode ?? null;
  while (current && typeof current.props.onPress !== 'function')
    current = current.parent as Queryable | null;
  if (!current) throw new Error(`Missing pressable: ${text}`);
  return current;
}

function findToggle(root: Queryable, label: string): Queryable {
  const labelNode = root.findAll((node) => node.children.map(String).join('') === label)[0];
  let current: Queryable | null = labelNode ?? null;
  while (current) {
    const toggle = current.findAll(
      (node) => node.type === Switch || typeof node.props.onValueChange === 'function',
    )[0];
    if (toggle) return toggle;
    current = current.parent as Queryable | null;
  }
  throw new Error(`Missing toggle: ${label}`);
}

function getPressCallback(node: Queryable): PressCallback {
  const callback = node.props.onPress;
  if (typeof callback !== 'function') throw new Error('Expected onPress callback');
  return callback as PressCallback;
}

function getToggleCallback(node: Queryable): ToggleCallback {
  const callback = node.props.onValueChange;
  if (typeof callback !== 'function') throw new Error('Expected onValueChange callback');
  return callback as ToggleCallback;
}

async function press(node: Queryable): Promise<void> {
  await act(async () => {
    getPressCallback(node)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function changeToggle(node: Queryable, value: boolean): Promise<void> {
  await act(async () => {
    getToggleCallback(node)(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSettings(
  options: {
    api?: Record<string, jest.Mock>;
    store?: AppStore;
    connected?: boolean;
    drawerToggle?: jest.Mock;
  } = {},
): Promise<{ tree: ReactTestRenderer; api: Record<string, jest.Mock>; store: AppStore }> {
  const api = options.api ?? {
    readBridgeCapabilities: jest.fn().mockResolvedValue(capabilities),
    registerPushDevice: jest.fn().mockResolvedValue(undefined),
    unregisterPushDevice: jest.fn().mockResolvedValue(undefined),
  };
  const store =
    options.store ??
    createSettingsStore({
      push: {
        optedOut: false,
        registrations: [
          { profileId: 'profile-1', registrationId: 'registration-1', token: 'old-token' },
        ],
      },
    });
  store.set(apiClientAtom, api as unknown as HostBridgeApiClient);
  store.set(bridgeConnectedAtom, options.connected ?? true);
  store.set(drawerCommandsAtom, {
    closeDrawer: jest.fn(),
    toggleNavigation: options.drawerToggle ?? jest.fn(),
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
          <AppThemeProvider theme={theme}>
            <SettingsScreen />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected SettingsScreen tree');
  return { tree, api, store };
}

describe('SettingsScreen behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestRegistration.mockResolvedValue({
      token: 'new-token',
      platform: 'ios',
      deviceName: 'Phone',
    });
  });

  it('renders capabilities and drives settings, profile, legal, retry, and drawer actions', async () => {
    const drawerToggle = jest.fn();
    const persistenceError = new AppStatePersistenceError('write_failed', 'write', 'save failed');
    const store = createSettingsStore({ workspaceChatLimit: 5, persistenceError });
    const { tree } = await renderSettings({ store, drawerToggle });
    const root = tree.root as Queryable;
    expect(hasText(root, 'Codex')).toBe(true);
    expect(hasText(root, 'Preferred · Active · ready · 1.2.3 · managed')).toBe(true);
    expect(hasText(root, 'Agent unavailable (details redacted)')).toBe(true);

    await changeToggle(findToggle(root, 'Require approvals'), false);
    await changeToggle(findToggle(root, 'Show tool calls'), false);
    await press(findPressableByText(root, 'Chats per workspace'));
    expect(store.get(approvalModeAtom)).toBe('yolo');
    expect(store.get(showToolCallsAtom)).toBe(false);
    expect(store.get(workspaceChatLimitAtom)).toBe(10);

    await press(findPressableByText(root, 'Primary'));
    expect(router.push).toHaveBeenCalledWith(routes.connection('profile-1', 'new', 'edit'), {
      withAnchor: true,
    });
    await press(findPressableByText(root, 'Add bridge'));
    expect(router.push).toHaveBeenCalledWith(routes.connection('profile-1', 'new', 'add'), {
      withAnchor: true,
    });

    await press(findPressableByText(root, 'Privacy policy'));
    expect(router.push).toHaveBeenCalledWith(routes.privacy('profile-1'));
    await press(findPressableByText(root, 'Terms of service'));
    expect(router.push).toHaveBeenCalledWith(routes.terms('profile-1'));

    await press(findPressableByText(root, 'Secondary'));
    expect(router.replace).toHaveBeenCalledWith(routes.newChat('profile-2'));

    const drawer = root.findAll(
      (node) => node.props.accessibilityLabel === 'Open navigation drawer',
    )[0];
    await press(drawer);
    expect(drawerToggle).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('reuses cached agent metadata without blanking on a settings revisit', async () => {
    const api = {
      readBridgeCapabilities: jest.fn().mockResolvedValue(capabilities),
      registerPushDevice: jest.fn(),
      unregisterPushDevice: jest.fn(),
    };
    const store = createSettingsStore();
    const first = await renderSettings({ api, store });
    expect(hasText(first.tree.root as Queryable, 'Codex')).toBe(true);
    act(() => first.tree.unmount());

    const second = await renderSettings({ api, store });
    expect(hasText(second.tree.root as Queryable, 'Codex')).toBe(true);
    expect(api.readBridgeCapabilities).toHaveBeenCalledTimes(1);
    act(() => second.tree.unmount());
  });

  it('surfaces a persistence failure and clears it after a retry', async () => {
    const store = createSettingsStore({
      persistenceError: new AppStatePersistenceError('write_failed', 'write', 'save failed'),
    });
    const { tree } = await renderSettings({ store });
    const root = tree.root as Queryable;
    expect(hasText(root, 'save failed')).toBe(true);
    await press(findPressableByText(root, 'Retry'));
    expect(store.get(appStateSnapshotAtom).persistenceError).toBeNull();
    act(() => tree.unmount());
  });

  it.each([
    { current: 10 as const, next: 25 },
    { current: 25 as const, next: null },
    { current: null, next: 5 },
  ])('cycles workspace limit $current to $next', async ({ current, next }) => {
    const store = createSettingsStore({ workspaceChatLimit: current });
    const { tree } = await renderSettings({ store });
    await press(findPressableByText(tree.root as Queryable, 'Chats per workspace'));
    expect(store.get(workspaceChatLimitAtom)).toBe(next);
    act(() => tree.unmount());
  });

  it('persists push enable, disable, and event changes through the real controller', async () => {
    const disabledStore = createSettingsStore({
      push: {
        optedOut: true,
        registrations: [
          { profileId: 'profile-1', registrationId: 'registration-1', token: 'old-token' },
        ],
      },
    });
    const enabled = await renderSettings({ store: disabledStore });
    await changeToggle(findToggle(enabled.tree.root as Queryable, 'Push notifications'), true);
    expect(enabled.api.registerPushDevice).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'new-token' }),
    );
    expect(disabledStore.get(pushSettingsAtom).optedOut).toBe(false);
    act(() => enabled.tree.unmount());

    const activeStore = createSettingsStore({
      push: {
        optedOut: false,
        registrations: [
          { profileId: 'profile-1', registrationId: 'registration-1', token: 'old-token' },
        ],
      },
    });
    const active = await renderSettings({ store: activeStore });
    const root = active.tree.root as Queryable;
    await changeToggle(findToggle(root, 'Push notifications'), false);
    expect(active.api.unregisterPushDevice).toHaveBeenCalled();
    expect(activeStore.get(pushSettingsAtom).optedOut).toBe(true);
    await changeToggle(findToggle(root, 'Approval requested'), false);
    expect(activeStore.get(pushSettingsAtom).events).toEqual({
      turnCompleted: true,
      approvalRequested: false,
    });
    act(() => active.tree.unmount());
  });

  it('shows empty and failed capability states, push errors, and ignores push changes without a profile', async () => {
    const empty = await renderSettings({
      api: {
        readBridgeCapabilities: jest.fn().mockResolvedValue({ ...capabilities, agents: [] }),
        registerPushDevice: jest.fn(),
        unregisterPushDevice: jest.fn(),
      },
    });
    expect(hasText(empty.tree.root as Queryable, 'No agents reported by this bridge.')).toBe(true);
    act(() => empty.tree.unmount());

    const failed = await renderSettings({
      api: {
        readBridgeCapabilities: jest.fn().mockRejectedValue(new Error('bridge offline')),
        registerPushDevice: jest.fn(),
        unregisterPushDevice: jest.fn(),
      },
      connected: false,
    });
    expect(hasText(failed.tree.root as Queryable, 'bridge offline')).toBe(true);
    expect(hasText(failed.tree.root as Queryable, 'Disconnected')).toBe(true);
    act(() => failed.tree.unmount());

    const unknownFailure = await renderSettings({
      api: {
        readBridgeCapabilities: jest.fn().mockRejectedValue('offline'),
        registerPushDevice: jest.fn(),
        unregisterPushDevice: jest.fn(),
      },
    });
    expect(
      hasText(unknownFailure.tree.root as Queryable, 'Could not read bridge capabilities.'),
    ).toBe(true);
    act(() => unknownFailure.tree.unmount());

    const errorStore = createSettingsStore({
      push: { optedOut: true },
      writeCurrent: jest.fn().mockRejectedValue(new Error('persist failed')),
    });
    const pushError = await renderSettings({ store: errorStore });
    await changeToggle(findToggle(pushError.tree.root as Queryable, 'Push notifications'), true);
    expect(
      hasText(
        pushError.tree.root as Queryable,
        'The app-state change was not saved. Please retry.',
      ),
    ).toBe(true);
    act(() => pushError.tree.unmount());

    const noProfileStore = createSettingsStore({ activeProfileId: null });
    const noProfile = await renderSettings({ store: noProfileStore });
    await changeToggle(findToggle(noProfile.tree.root as Queryable, 'Push notifications'), true);
    await changeToggle(findToggle(noProfile.tree.root as Queryable, 'Turn completed'), false);
    expect(noProfileStore.get(pushSettingsAtom).optedOut).toBe(false);
    expect(noProfileStore.get(pushSettingsAtom).events.turnCompleted).toBe(true);
    act(() => noProfile.tree.unmount());
  });
});
