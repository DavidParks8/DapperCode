/* eslint-disable @typescript-eslint/consistent-type-imports, @typescript-eslint/no-require-imports -- Jest factories require hoist-safe module access. */
import { AppState, BackHandler, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AppStatePersistenceError, type AppStateSnapshot } from './src/appState';

const mockScreenProps: Record<string, Record<string, unknown>> = {};
const mockWsInstances: Array<Record<string, unknown>> = [];
const mockApiInstances: Array<Record<string, unknown>> = [];
const mockPushControllers: Array<Record<string, jest.Mock>> = [];
const mockWsStatusListeners: Array<(connected: boolean) => void> = [];
const mockAppStateListeners: Array<(state: AppStateStatus) => void> = [];
const mockNotificationResponseListeners: Array<(event: unknown) => void> = [];
interface MockGesture {
  testId?: string;
  enabled?: boolean;
  onStart?: (...args: unknown[]) => unknown;
  onUpdate?: (...args: unknown[]) => unknown;
  onEnd?: (...args: unknown[]) => unknown;
  onFinalize?: (...args: unknown[]) => unknown;
}
const mockGestures: MockGesture[] = [];
const mockLoadChatSnapshotCache = jest.fn().mockResolvedValue(null);
const mockSaveChatSnapshotCache = jest.fn().mockResolvedValue(undefined);
const mockDeleteChatSnapshotCache = jest.fn().mockResolvedValue(undefined);
const mockSyncPushRegistration = jest.fn().mockResolvedValue(undefined);
const mockGetInitialNotificationResponse = jest.fn().mockResolvedValue(null);
const mockIsAutoStoreReviewEligible = jest.fn().mockReturnValue(false);
const mockLoadAutoStoreReviewState = jest.fn().mockResolvedValue({
  accumulatedForegroundMs: 0,
  automaticRequestAt: '2026-07-20T00:00:00.000Z',
});
const mockRequestNativeStoreReview = jest.fn().mockResolvedValue(false);
const mockSaveAutoStoreReviewState = jest.fn().mockResolvedValue(undefined);
const mockStore = {
  initialize: jest.fn().mockResolvedValue(undefined),
  dispatch: jest.fn(),
  dispatchDurable: jest.fn(),
  retryPersistence: jest.fn().mockResolvedValue(undefined),
  flushPersistence: jest.fn().mockResolvedValue(undefined),
};

let mockSnapshot: AppStateSnapshot;
let mockBackHandler: (() => boolean | null | undefined) | null = null;
let previousAppState: typeof AppState.currentState;
let mockSpringFinished = true;

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context');
  return {
    ...actual,
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    },
  };
});
jest.mock('react-native-reanimated', () => {
  const View = require('react-native').View;
  const transition = { duration: () => transition, easing: () => transition };
  return {
    __esModule: true,
    default: { View },
    cancelAnimation: jest.fn(),
    Easing: { out: (value: unknown) => value, cubic: 'cubic' },
    LinearTransition: transition,
    ReduceMotion: { System: 'system' },
    runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withSpring: (value: unknown, _config: unknown, callback?: (finished: boolean) => void) => {
      callback?.(mockSpringFinished);
      return value;
    },
  };
});
jest.mock('react-native-gesture-handler', () => {
  const View = require('react-native').View;
  const createGesture = () => {
    const callbacks: MockGesture = {};
    const gesture = new Proxy(callbacks, {
      get:
        (target, property: string) =>
        (...args: unknown[]) => {
          if (property.startsWith('on') && typeof args[0] === 'function') {
            Object.assign(target, { [property]: args[0] });
          } else if (property === 'withTestId' && typeof args[0] === 'string') {
            target.testId = args[0];
          } else if (property === 'enabled' && typeof args[0] === 'boolean') {
            target.enabled = args[0];
          }
          return gesture;
        },
    });
    mockGestures.push(callbacks);
    return gesture;
  };
  return {
    Gesture: { Pan: createGesture, Tap: createGesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: View,
  };
});
jest.mock('./src/state/appState/persistenceCoordinator', () => ({
  getAppStateCoordinator: () => mockStore,
}));
jest.mock('./src/appStatePersistence', () => ({ createAppStatePersistence: () => ({}) }));
jest.mock('./src/api/ws', () => ({
  HostBridgeWsClient: class {
    isConnected = true;
    connect = jest.fn();
    disconnect = jest.fn();
    onStatus = jest.fn((listener: (connected: boolean) => void) => {
      mockWsStatusListeners.push(listener);
      return jest.fn();
    });
    mockUrl: string;
    mockOptions: unknown;
    constructor(mockUrl: string, mockOptions: unknown) {
      this.mockUrl = mockUrl;
      this.mockOptions = mockOptions;
      mockWsInstances.push(this as unknown as Record<string, unknown>);
    }
  },
}));
jest.mock('./src/api/client', () => ({
  HostBridgeApiClient: class {
    primeChats = jest.fn().mockResolvedValue([]);
    peekChatShell = jest.fn().mockReturnValue(null);
    rememberChat = jest.fn();
    mockOptions: unknown;
    constructor(mockOptions: unknown) {
      this.mockOptions = mockOptions;
      mockApiInstances.push(this as unknown as Record<string, unknown>);
    }
  },
}));
jest.mock('./src/appWebSocketLifecycle', () => ({
  bindAppWebSocketLifecycle: jest.fn().mockReturnValue(jest.fn()),
}));
jest.mock('./src/chatSnapshotCache', () => ({
  createEmptyChatSnapshotCache: (profileId: string) => ({
    version: 1,
    profileId,
    selectedChatId: null,
    entries: [],
  }),
  deleteChatSnapshotCache: (...args: unknown[]) => mockDeleteChatSnapshotCache(...args),
  loadChatSnapshotCache: (...args: unknown[]) => mockLoadChatSnapshotCache(...args),
  saveChatSnapshotCache: (...args: unknown[]) => mockSaveChatSnapshotCache(...args),
  updateChatSnapshotCache: (cache: unknown, selectedChatId: string | null, chat: unknown) => ({
    ...(cache as object),
    selectedChatId,
    entries: chat ? [{ chat }] : [],
  }),
}));
jest.mock('./src/pushNotifications', () => ({
  setupNotificationHandler: jest.fn(),
  registerNotificationCategories: jest.fn().mockResolvedValue(undefined),
  addNotificationResponseListener: jest.fn((listener: (event: unknown) => void) => {
    mockNotificationResponseListeners.push(listener);
    return { remove: jest.fn() };
  }),
  getInitialNotificationResponse: (...args: unknown[]) =>
    mockGetInitialNotificationResponse(...args),
}));
jest.mock('./src/pushController', () => ({
  syncPushRegistration: (...args: unknown[]) => mockSyncPushRegistration(...args),
}));
jest.mock('./src/pushResponseController', () => ({
  PushResponseController: class {
    handle = jest.fn();
    setProfile = jest.fn();
    dispose = jest.fn();
    navigate: jest.Mock;
    constructor(mockCallback: jest.Mock) {
      this.navigate = mockCallback;
      mockPushControllers.push(this as unknown as Record<string, jest.Mock>);
    }
  },
}));
jest.mock('./src/storeReview', () => ({
  AUTO_STORE_REVIEW_THRESHOLD_MS: 600_000,
  createDefaultAutoStoreReviewState: () => ({
    accumulatedForegroundMs: 0,
    automaticRequestAt: null,
  }),
  isAutoStoreReviewEligible: (...args: unknown[]) => mockIsAutoStoreReviewEligible(...args),
  loadAutoStoreReviewState: (...args: unknown[]) => mockLoadAutoStoreReviewState(...args),
  requestNativeStoreReview: (...args: unknown[]) => mockRequestNativeStoreReview(...args),
  saveAutoStoreReviewState: (...args: unknown[]) => mockSaveAutoStoreReviewState(...args),
}));
jest.mock('./src/config', () => ({
  env: {
    hostBridgeToken: 'env-token',
    legacyHostBridgeUrl: 'http://legacy:3001',
    allowWsQueryTokenAuth: false,
    allowInsecureRemoteBridge: false,
    privacyPolicyUrl: 'https://example.com/privacy',
    termsOfServiceUrl: 'https://example.com/terms',
  },
}));

function mockScreen(name: string, refMethods?: Record<string, jest.Mock>) {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const Component = React.forwardRef(function MockScreen(props: Record<string, unknown>, ref) {
    mockScreenProps[name] = props;
    React.useImperativeHandle(ref, () => refMethods ?? {});
    return React.createElement(View, { testID: name });
  });
  return { [name]: Component };
}

const mockStartNewChat = jest.fn();
const mockBrowserBack = jest.fn().mockReturnValue(false);
jest.mock('./src/screens/main/MainScreen', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const jotai = require('jotai') as typeof import('jotai');
  const { mainScreenCommandsAtom } =
    require('./src/state/commands') as typeof import('./src/state/commands');
  return {
    MainScreen: function MockMainScreen(props: Record<string, unknown>) {
      mockScreenProps.MainScreen = props;
      const setCommands = jotai.useSetAtom(mainScreenCommandsAtom);
      React.useEffect(() => {
        setCommands({ startNewChat: mockStartNewChat, openChat: jest.fn() });
        return () => setCommands(null);
      }, [setCommands]);
      return React.createElement(View, { testID: 'MainScreen' });
    },
  };
});
jest.mock('./src/screens/browser/BrowserScreen', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');
  const jotai = require('jotai') as typeof import('jotai');
  const { browserScreenCommandsAtom } =
    require('./src/state/commands') as typeof import('./src/state/commands');
  return {
    BrowserScreen: function MockBrowserScreen(props: Record<string, unknown>) {
      mockScreenProps.BrowserScreen = props;
      const setCommands = jotai.useSetAtom(browserScreenCommandsAtom);
      React.useEffect(() => {
        setCommands({ handleHardwareBackPress: mockBrowserBack });
        return () => setCommands(null);
      }, [setCommands]);
      return React.createElement(View, { testID: 'BrowserScreen' });
    },
  };
});
jest.mock('./src/screens/git/GitScreen', () => mockScreen('GitScreen'));
jest.mock('./src/screens/onboarding/OnboardingScreen', () => mockScreen('OnboardingScreen'));
jest.mock('./src/screens/legal/PrivacyScreen', () => mockScreen('PrivacyScreen'));
jest.mock('./src/screens/settings/SettingsScreen', () => mockScreen('SettingsScreen'));
jest.mock('./src/screens/legal/TermsScreen', () => mockScreen('TermsScreen'));
jest.mock('./src/navigation/DrawerContent', () => mockScreen('DrawerContent'));

import { AppRoot } from './src/app/AppRoot';
import { AppStateProvider, createAppStore } from './src/state/store';
import { appStateSnapshotAtom, bridgeProfilesAtom } from './src/state/appState/atoms';
import {
  approvalModeAtom,
  appearancePreferenceAtom,
  darkUiPaletteAtom,
  defaultStartCwdAtom,
  recentBrowserTargetUrlsAtom,
  rememberThreadSettingsAtom,
  showToolCallsAtom,
  workspaceChatLimitAtom,
} from './src/state/appState/settings';
import { retryPersistenceAtom } from './src/state/appState/actions';
import {
  addBridgeProfileAtom,
  cancelOnboardingAtom,
  clearSavedBridgesAtom,
  deleteBridgeProfileAtom,
  editBridgeProfileAtom,
  openBridgeRecoveryGuideAtom,
  renameBridgeProfileAtom,
  saveBridgeProfileAtom,
  switchBridgeProfileAtom,
} from './src/state/bridge/actions';
import { activeBridgeProfileAtom } from './src/state/bridge/atoms';
import {
  activeChatAtom,
  chatTransitionChatIdAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
} from './src/state/chat/atoms';
import {
  closeDrawerAtom,
  drawerCommandsAtom,
  drawerOpenAtom,
  drawerVisibleAtom,
} from './src/state/drawer/atoms';
import {
  chatContextChangedAtom,
  closeGitAtom,
  navigateAtom,
  openBrowserAtom,
  openChatGitAtom,
  openLegalScreenAtom,
  selectChatAtom,
  startNewChatAtom,
} from './src/state/navigation/actions';
import {
  currentScreenAtom,
  navigationStackAtom,
  onboardingModeAtom,
  pendingBrowserTargetUrlAtom,
  pushNavigationRouteAtom,
  settingsAllowsDrawerGestureAtom,
} from './src/state/navigation/atoms';
import type { AppStore } from './src/state/types';
import type { Chat } from './src/api/types';

type Queryable = ReactTestInstance & {
  children: unknown[];
  parent: Queryable | null;
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

const profile = {
  id: 'profile-1',
  name: 'Local bridge',
  bridgeUrl: 'http://127.0.0.1:3001',
  bridgeToken: 'profile-token',
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:00:00.000Z',
};

function snapshot(
  options: {
    loaded?: boolean;
    profiles?: (typeof profile)[];
    activeProfileId?: string | null;
    persistenceError?: AppStateSnapshot['persistenceError'];
    settings?: Partial<AppStateSnapshot['data']['settings']>;
    registrations?: AppStateSnapshot['data']['push']['registrations'];
  } = {},
): AppStateSnapshot {
  return {
    loaded: options.loaded ?? true,
    persistenceError: options.persistenceError ?? null,
    data: {
      settings: {
        defaultStartCwd: null,
        preferredAgentId: 'codex',
        agentSettings: {},
        approvalMode: 'normal',
        showToolCalls: true,
        workspaceChatLimit: 5,
        appearancePreference: 'system',
        darkUiPalette: 'classic',
        recentBrowserTargetUrls: [],
        ...options.settings,
      },
      bridgeProfiles: {
        activeProfileId:
          options.activeProfileId === undefined ? profile.id : options.activeProfileId,
        profiles: options.profiles ?? [profile],
      },
      push: {
        optedOut: false,
        events: { turnCompleted: true, approvalRequested: true },
        registrations: options.registrations ?? [],
      },
    },
  };
}

let store: AppStore;

async function renderApp(): Promise<ReactTestRenderer> {
  store = createAppStore({
    persistence: {
      readCurrent: () => Promise.resolve(null),
      writeCurrent: () => Promise.resolve(),
      readLegacy: () => Promise.resolve({ settingsRaw: null, bridgeProfilesRaw: null }),
    },
  });
  store.set(appStateSnapshotAtom, mockSnapshot);
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(
      <AppStateProvider store={store}>
        <AppRoot />
      </AppStateProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('Expected App tree');
  return tree;
}

async function dispatch(action: (currentStore: AppStore) => unknown): Promise<void> {
  await act(async () => {
    await action(store);
    await Promise.resolve();
  });
}

async function flushTimers(ms = 0): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('App orchestration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSnapshot = snapshot();
    mockSpringFinished = true;
    mockBackHandler = null;
    mockScreenProps.MainScreen = {};
    mockScreenProps.SettingsScreen = {};
    mockScreenProps.OnboardingScreen = {};
    mockWsInstances.length = 0;
    mockApiInstances.length = 0;
    mockPushControllers.length = 0;
    mockWsStatusListeners.length = 0;
    mockAppStateListeners.length = 0;
    mockNotificationResponseListeners.length = 0;
    mockGestures.length = 0;
    jest.clearAllMocks();
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, callback) => {
      mockBackHandler = () => callback({ type: 'hardwareBackPress', timeStamp: 0 });
      return { remove: jest.fn() };
    });
    previousAppState = AppState.currentState;
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
      writable: true,
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      mockAppStateListeners.push(listener);
      return {
        remove: jest.fn(() => {
          const listenerIndex = mockAppStateListeners.indexOf(listener);
          if (listenerIndex >= 0) mockAppStateListeners.splice(listenerIndex, 1);
        }),
      };
    });
  });

  afterEach(() => {
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: previousAppState,
      writable: true,
    });
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('renders state loading and persistence recovery branches', async () => {
    mockSnapshot = snapshot({ loaded: false });
    const loading = await renderApp();
    expect(
      (loading.root as Queryable).findAll(
        (node) => node.props.accessibilityLabel === 'Loading DapperCode',
      ).length,
    ).toBeGreaterThan(0);
    act(() => loading.unmount());

    mockSnapshot = snapshot({
      persistenceError: new AppStatePersistenceError(
        'read_failed',
        'load',
        'secure storage unavailable',
      ),
    });
    const recovery = await renderApp();
    expect(
      (recovery.root as Queryable).findAll((node) =>
        node.children.includes('secure storage unavailable'),
      ),
    ).toHaveLength(1);
    const retryText = (recovery.root as Queryable).findAll((node) =>
      node.children.includes('Retry'),
    )[0];
    let retry = retryText as Queryable | null;
    while (retry && typeof retry.props.onPress !== 'function')
      retry = retry.parent as Queryable | null;
    await act(async () => (retry?.props.onPress as () => Promise<void>)());
    expect(mockStore.retryPersistence).toHaveBeenCalled();
    act(() => recovery.unmount());
  });

  it('keeps the main screen unavailable until cached chat restoration settles', async () => {
    let resolveCache: (value: null) => void = () => undefined;
    mockLoadChatSnapshotCache.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveCache = resolve;
      }),
    );
    const tree = await renderApp();
    const root = tree.root as Queryable;

    expect(
      root.findAll((node) => node.props.accessibilityLabel === 'Loading DapperCode'),
    ).not.toHaveLength(0);
    expect(root.findAll((node) => node.props.testID === 'MainScreen')).toHaveLength(0);

    await flushTimers(250);
    expect(root.findAll((node) => node.props.testID === 'MainScreen')).toHaveLength(0);
    expect(mockSaveChatSnapshotCache).not.toHaveBeenCalled();

    await act(async () => {
      resolveCache(null);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(root.findAll((node) => node.props.testID === 'MainScreen')).not.toHaveLength(0);
    act(() => tree.unmount());
  });

  it('restores the selected cached chat and persists subsequent context', async () => {
    const cachedChat = {
      id: 'cached',
      title: 'Cached',
      status: 'complete',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      statusUpdatedAt: '2026-07-20T00:00:00.000Z',
      lastMessagePreview: 'ready',
      messages: [{ id: 'message-1', role: 'assistant', content: 'ready' }],
    };
    mockLoadChatSnapshotCache.mockResolvedValueOnce({
      version: 1,
      profileId: profile.id,
      selectedChatId: cachedChat.id,
      entries: [{ chat: cachedChat }],
    });
    const tree = await renderApp();
    expect(store.get(pendingMainChatIdAtom)).toBe(cachedChat.id);
    expect(store.get(pendingMainChatSnapshotAtom)).toEqual(cachedChat);
    expect(mockApiInstances[0].rememberChat).toHaveBeenCalledWith(cachedChat);
    await dispatch((s) => {
      s.set(pendingMainChatIdAtom, null);
      s.set(pendingMainChatSnapshotAtom, null);
    });
    await dispatch((s) => s.set(chatContextChangedAtom, cachedChat as unknown as Chat));
    await flushTimers(250);
    expect(mockSaveChatSnapshotCache).toHaveBeenCalledWith(
      expect.objectContaining({ selectedChatId: cachedChat.id }),
    );
    act(() => tree.unmount());
  });

  it('uses profile and environment tokens in client options', async () => {
    const withProfileToken = await renderApp();
    expect(mockWsInstances[0].mockOptions).toEqual({
      authToken: 'profile-token',
      allowQueryTokenAuth: false,
    });
    expect(mockApiInstances[0].mockOptions).toEqual(
      expect.objectContaining({ authToken: 'profile-token', bridgeUrl: profile.bridgeUrl }),
    );
    act(() => withProfileToken.unmount());

    mockSnapshot = snapshot({ profiles: [{ ...profile, bridgeToken: null as unknown as string }] });
    const withEnvironmentToken = await renderApp();
    expect(mockWsInstances.at(-1)?.mockOptions).toEqual({
      authToken: 'env-token',
      allowQueryTokenAuth: false,
    });
    expect(mockApiInstances.at(-1)?.mockOptions).toEqual(
      expect.objectContaining({ authToken: 'env-token' }),
    );
    act(() => withEnvironmentToken.unmount());
  });

  it('dispatches every settings and browser persistence callback', async () => {
    mockSnapshot = snapshot({ settings: { recentBrowserTargetUrls: ['http://recent:5173'] } });
    const tree = await renderApp();
    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    const updates = [
      () => store.set(approvalModeAtom, 'yolo'),
      () => store.set(showToolCallsAtom, false),
      () => store.set(workspaceChatLimitAtom, 25),
      () => store.set(appearancePreferenceAtom, 'dark'),
      () => store.set(darkUiPaletteAtom, 'grey'),
    ];
    for (const update of updates) await dispatch(update);
    await dispatch((s) => s.set(retryPersistenceAtom));
    await dispatch((s) => s.set(settingsAllowsDrawerGestureAtom, false));
    await dispatch((s) => s.get(drawerCommandsAtom)?.toggleNavigation());
    act(() => expect(mockBackHandler?.()).toBe(true));
    await dispatch((s) => s.set(navigateAtom, 'Browser'));
    expect(store.get(recentBrowserTargetUrlsAtom)).toEqual(['http://recent:5173']);
    await dispatch((s) => s.set(recentBrowserTargetUrlsAtom, ['http://next:5173']));
    await dispatch((s) => s.set(pendingBrowserTargetUrlAtom, null));
    expect(mockStore.dispatch).toHaveBeenCalledTimes(updates.length + 1);
    expect(mockStore.retryPersistence).toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it('continues after write persistence errors and initialization failures', async () => {
    mockSnapshot = snapshot({
      persistenceError: new AppStatePersistenceError('write_failed', 'write', 'write failed'),
    });
    mockStore.initialize.mockRejectedValueOnce(new Error('load failed'));
    const tree = await renderApp();
    expect(store.get(activeBridgeProfileAtom)?.id).toBe(profile.id);
    act(() => tree.unmount());
  });

  it('routes no-profile state to initial onboarding and saves normalized credentials', async () => {
    mockSnapshot = snapshot({ profiles: [], activeProfileId: null });
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] },
    });
    const tree = await renderApp();
    expect(mockScreenProps.OnboardingScreen?.mode).toBe('initial');
    expect(mockScreenProps.OnboardingScreen?.initialBridgeUrl).toBe('http://legacy:3001');
    await expect(
      dispatch((s) =>
        s.set(saveBridgeProfileAtom, {
          bridgeUrl: ' http://127.0.0.1:3001 ',
          bridgeToken: ' token ',
        }),
      ),
    ).resolves.toBeUndefined();
    expect(mockStore.dispatchDurable).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'profiles/save' }),
    );
    act(() => tree.unmount());
  });

  it('rejects incomplete onboarding credentials and adds a profile', async () => {
    mockSnapshot = snapshot({ profiles: [], activeProfileId: null });
    const tree = await renderApp();
    await expect(
      dispatch((s) => s.set(saveBridgeProfileAtom, { bridgeUrl: '', bridgeToken: 'token' })),
    ).rejects.toThrow('required');
    await expect(
      dispatch((s) =>
        s.set(saveBridgeProfileAtom, { bridgeUrl: profile.bridgeUrl, bridgeToken: ' ' }),
      ),
    ).rejects.toThrow('required');
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] },
    });
    await dispatch((s) =>
      s.set(saveBridgeProfileAtom, {
        bridgeUrl: profile.bridgeUrl,
        bridgeToken: profile.bridgeToken,
      }),
    );
    expect(mockLoadChatSnapshotCache).toHaveBeenCalledWith(profile.id);
    expect(store.get(currentScreenAtom)).toBe('Main');
    act(() => tree.unmount());
  });

  it('adds and edits profiles with changed and unchanged bridge identities', async () => {
    const tree = await renderApp();
    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    await dispatch((s) => s.set(addBridgeProfileAtom));
    expect(store.get(onboardingModeAtom)).toBe('add');
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] },
    });
    await dispatch((s) =>
      s.set(saveBridgeProfileAtom, {
        bridgeUrl: profile.bridgeUrl,
        bridgeToken: profile.bridgeToken,
      }),
    );

    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    await dispatch((s) => s.set(editBridgeProfileAtom));
    expect(store.get(onboardingModeAtom)).toBe('edit');
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] },
    });
    await dispatch((s) =>
      s.set(saveBridgeProfileAtom, {
        bridgeUrl: 'http://changed:3001',
        bridgeToken: 'changed-token',
      }),
    );
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(profile.id);

    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    await dispatch((s) => s.set(editBridgeProfileAtom));
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] },
    });
    await dispatch((s) =>
      s.set(saveBridgeProfileAtom, {
        bridgeUrl: profile.bridgeUrl,
        bridgeToken: profile.bridgeToken,
      }),
    );
    expect(mockLoadChatSnapshotCache).toHaveBeenCalledWith(profile.id);
    act(() => tree.unmount());
  });

  it('switches, renames, deletes, and clears bridge profiles', async () => {
    const secondProfile = {
      ...profile,
      id: 'profile-2',
      name: 'Remote bridge',
      bridgeUrl: 'https://bridge.example',
    };
    const switchedChat = {
      id: 'switched',
      title: 'Switched',
      status: 'complete',
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      statusUpdatedAt: profile.updatedAt,
      lastMessagePreview: '',
      messages: [],
    };
    mockSnapshot = snapshot({ profiles: [profile, secondProfile] });
    const tree = await renderApp();
    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    mockLoadChatSnapshotCache.mockResolvedValueOnce({
      version: 1,
      profileId: secondProfile.id,
      selectedChatId: switchedChat.id,
      entries: [{ chat: switchedChat }],
    });
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: secondProfile.id, profiles: [profile, secondProfile] },
    });
    await dispatch((s) => s.set(switchBridgeProfileAtom, secondProfile.id));
    expect(mockStore.dispatchDurable).toHaveBeenCalledWith({
      type: 'profiles/switch',
      profileId: secondProfile.id,
    });
    expect(store.get(currentScreenAtom)).toBe('Settings');
    expect(store.get(navigationStackAtom)).toEqual([{ screen: 'Main' }, { screen: 'Settings' }]);
    await dispatch((s) => s.set(renameBridgeProfileAtom, secondProfile.id, 'Renamed'));
    expect(mockStore.dispatchDurable).toHaveBeenCalledWith({
      type: 'profiles/rename',
      profileId: secondProfile.id,
      name: 'Renamed',
    });

    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: profile.id, profiles: [profile] },
    });
    await dispatch((s) => s.set(deleteBridgeProfileAtom, secondProfile.id));
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(secondProfile.id);
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: null, profiles: [] },
    });
    await dispatch((s) => s.set(deleteBridgeProfileAtom, profile.id));
    expect(mockScreenProps.OnboardingScreen?.mode).toBe('initial');
    act(() => tree.unmount());

    mockSnapshot = snapshot({ profiles: [profile, secondProfile] });
    const clearTree = await renderApp();
    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: null, profiles: [] },
    });
    await dispatch((s) => s.set(clearSavedBridgesAtom));
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(profile.id);
    expect(mockDeleteChatSnapshotCache).toHaveBeenCalledWith(secondProfile.id);
    expect(mockScreenProps.OnboardingScreen?.mode).toBe('initial');
    act(() => clearTree.unmount());
  });

  it('constructs active clients and routes through all owned screens', async () => {
    const tree = await renderApp();
    expect(mockWsInstances[0]).toEqual(expect.objectContaining({ mockUrl: profile.bridgeUrl }));
    expect(store.get(activeBridgeProfileAtom)?.id).toBe(profile.id);
    expect(store.get(pendingMainChatIdAtom)).toBeNull();
    await dispatch((s) => s.set(startNewChatAtom));
    expect(mockStartNewChat).toHaveBeenCalled();

    await dispatch((s) => s.set(openBrowserAtom, '  http://127.0.0.1:5173  '));
    expect(store.get(pendingBrowserTargetUrlAtom)).toBe('http://127.0.0.1:5173');
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(store.get(activeBridgeProfileAtom)?.id).toBe(profile.id);

    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    expect(store.get(currentScreenAtom)).toBe('Settings');
    await dispatch((s) => s.set(openLegalScreenAtom, 'Privacy'));
    expect(mockScreenProps.PrivacyScreen.policyUrl).toContain('privacy');
    act(() => expect(mockBackHandler?.()).toBe(true));
    await dispatch((s) => s.set(openLegalScreenAtom, 'Terms'));
    expect(mockScreenProps.TermsScreen.termsUrl).toContain('terms');
    act(() => expect(mockBackHandler?.()).toBe(true));
    act(() => tree.unmount());
  });

  it('selects current, empty, and hydrated chats through the drawer', async () => {
    const hydrated = {
      id: 'hydrated',
      title: 'Hydrated',
      status: 'complete',
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      statusUpdatedAt: profile.updatedAt,
      lastMessagePreview: 'hello',
      messages: [{ id: 'm1', role: 'assistant', content: 'hello' }],
    };
    const tree = await renderApp();
    await dispatch((s) => s.set(chatContextChangedAtom, hydrated as unknown as Chat));
    await dispatch((s) => s.set(selectChatAtom, hydrated.id));
    (mockApiInstances[0].peekChatShell as jest.Mock).mockReturnValueOnce(hydrated);
    await dispatch((s) => s.set(selectChatAtom, hydrated.id));
    await dispatch((s) => s.set(selectChatAtom, 'empty-shell'));
    await flushTimers(250);
    expect(store.get(pendingMainChatIdAtom)).toBe('empty-shell');
    await dispatch((s) => s.set(mainOpeningChatIdAtom, null));
    await dispatch((s) => s.set(chatContextChangedAtom, null as unknown as Chat));
    await dispatch((s) => s.set(rememberThreadSettingsAtom, 'codex', 'plan'));
    expect(mockStore.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'settings/remember-thread' }),
    );
    act(() => tree.unmount());
  });

  it('executes drawer gesture worklets across bounds and velocity decisions', async () => {
    const tree = await renderApp();
    const openGesture = mockGestures[1];
    const visibleGesture = mockGestures[2];
    const tapGesture = mockGestures[3];
    act(() => {
      openGesture.onStart?.();
      openGesture.onUpdate?.({ translationX: 500 });
      openGesture.onUpdate?.({ translationX: -500 });
      openGesture.onUpdate?.({ translationX: 120 });
      openGesture.onEnd?.({ translationX: 120, velocityX: 1000 });
      openGesture.onFinalize?.({ velocityX: 0 });
      visibleGesture.onStart?.();
      visibleGesture.onUpdate?.({ translationX: -500 });
      visibleGesture.onEnd?.({ translationX: -100, velocityX: -1000 });
      visibleGesture.onStart?.();
      visibleGesture.onFinalize?.({ velocityX: 1000 });
      tapGesture.onEnd?.({}, false);
      tapGesture.onEnd?.({}, true);
    });
    expect(mockScreenProps.DrawerContent?.active).toBe(false);
    act(() => tree.unmount());
  });

  it('covers rejected and unfinished drawer gesture decisions', async () => {
    mockSpringFinished = false;
    const tree = await renderApp();
    const chatBackGesture = mockGestures[0];
    const openGesture = mockGestures[1];
    const visibleGesture = mockGestures[2];
    act(() => {
      chatBackGesture.onEnd?.({ translationX: 0, velocityX: 0 });
      chatBackGesture.onEnd?.({ translationX: 60, velocityX: 0 });
      openGesture.onStart?.();
      openGesture.onEnd?.({ translationX: 10, velocityX: 0 });
      openGesture.onStart?.();
      openGesture.onFinalize?.({ velocityX: -1000 });
      visibleGesture.onStart?.();
      visibleGesture.onEnd?.({ translationX: 100, velocityX: 1000 });
      visibleGesture.onStart?.();
      visibleGesture.onFinalize?.({ velocityX: -1000 });
    });
    act(() => tree.unmount());
  });

  it('toggles the tablet sidebar and suppresses phone drawer animation', async () => {
    jest
      .spyOn(require('react-native'), 'useWindowDimensions')
      .mockReturnValue({ width: 800, height: 1024, scale: 2, fontScale: 1 });
    const tree = await renderApp();
    expect(mockScreenProps.DrawerContent?.active).toBe(true);
    await dispatch((s) => s.get(drawerCommandsAtom)?.toggleNavigation());
    await dispatch((s) => s.get(drawerCommandsAtom)?.toggleNavigation());
    act(() => expect(mockBackHandler?.()).toBe(false));
    act(() => tree.unmount());
  });

  it('opens Git, returns to chat, updates settings, and enters recovery onboarding', async () => {
    const tree = await renderApp();
    const chat = {
      id: 'thread-1',
      title: 'Thread',
      status: 'complete',
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      statusUpdatedAt: '2026-07-20T00:00:00.000Z',
      lastMessagePreview: '',
      messages: [],
    };
    await dispatch((s) => {
      s.set(chatContextChangedAtom, chat as unknown as Chat);
      s.set(openChatGitAtom, chat as unknown as Chat);
    });
    expect(store.get(gitChatAtom)).toEqual(chat);
    await act(async () => {
      store.set(closeGitAtom);
      jest.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(store.get(currentScreenAtom)).toBe('Main');
    expect(store.get(pendingMainChatIdAtom)).toBeNull();
    expect(store.get(activeChatAtom)).toEqual(chat);
    await dispatch((s) => s.set(defaultStartCwdAtom, '/workspace'));
    expect(mockStore.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'settings/update' }),
    );
    await dispatch((s) => s.set(openBridgeRecoveryGuideAtom));
    expect(store.get(onboardingModeAtom)).toBe('reconnect');
    expect(store.get(activeBridgeProfileAtom)).not.toBeNull();
    await dispatch((s) => s.set(cancelOnboardingAtom));
    expect(store.get(activeBridgeProfileAtom)?.id).toBe(profile.id);
    act(() => tree.unmount());
  });

  it('handles drawer and hardware back from every routed screen', async () => {
    const tree = await renderApp();
    act(() => expect(mockBackHandler?.()).toBe(false));
    await dispatch((s) => s.get(drawerCommandsAtom)?.toggleNavigation());
    act(() => expect(mockBackHandler?.()).toBe(true));

    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(store.get(activeBridgeProfileAtom)?.id).toBe(profile.id);
    await dispatch((s) => s.set(navigateAtom, 'Privacy'));
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(store.get(currentScreenAtom)).toBe('Settings');
    await dispatch((s) => s.set(navigateAtom, 'Terms'));
    act(() => expect(mockBackHandler?.()).toBe(true));

    await dispatch((s) => s.set(openBrowserAtom, null));
    mockBrowserBack.mockReturnValueOnce(true);
    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(store.get(currentScreenAtom)).toBe('Browser');
    mockBrowserBack.mockReturnValueOnce(false);
    act(() => expect(mockBackHandler?.()).toBe(true));

    const chat = {
      id: 'git-back',
      title: 'Git',
      status: 'complete',
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      statusUpdatedAt: profile.updatedAt,
      lastMessagePreview: '',
      messages: [],
    };
    await dispatch((s) => s.set(openChatGitAtom, chat as unknown as Chat));
    act(() => expect(mockBackHandler?.()).toBe(true));
    await flushTimers(250);

    await dispatch((s) => s.set(openBridgeRecoveryGuideAtom));
    act(() => expect(mockBackHandler?.()).toBe(true));
    act(() => tree.unmount());

    mockSnapshot = snapshot({ profiles: [], activeProfileId: null });
    const initial = await renderApp();
    act(() => expect(mockBackHandler?.()).toBe(false));
    act(() => initial.unmount());
  });

  it('navigates back in the stack when swiping from the left screen edge', async () => {
    const tree = await renderApp();
    const backSwipeGesture = mockGestures[0];

    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    expect(store.get(currentScreenAtom)).toBe('Settings');
    await act(async () => {
      backSwipeGesture.onEnd?.({ translationX: 10, velocityX: 0 });
      await Promise.resolve();
    });
    expect(store.get(currentScreenAtom)).toBe('Settings');
    await act(async () => {
      backSwipeGesture.onEnd?.({ translationX: 120, velocityX: 0 });
      await Promise.resolve();
    });
    expect(store.get(activeBridgeProfileAtom)?.id).toBe(profile.id);
    act(() => tree.unmount());
  });

  it('pops a sub-agent route before allowing the sessions drawer to open', async () => {
    const tree = await renderApp();
    const gestureCount = mockGestures.length;

    await dispatch((s) => {
      s.set(pushNavigationRouteAtom, { screen: 'SubAgent', threadId: 'sub-agent-1' });
      s.set(pushNavigationRouteAtom, { screen: 'SubAgent', threadId: 'sub-agent-2' });
    });
    expect(store.get(currentScreenAtom)).toBe('SubAgent');
    expect(store.get(navigationStackAtom)).toEqual([
      { screen: 'Main' },
      { screen: 'SubAgent', threadId: 'sub-agent-1' },
      { screen: 'SubAgent', threadId: 'sub-agent-2' },
    ]);
    const detailGestures = mockGestures.slice(gestureCount);
    const backSwipeGesture = detailGestures.find((gesture) => gesture.testId === 'app-back-swipe');
    const openDrawerGesture = detailGestures.find(
      (gesture) => gesture.testId === 'app-open-drawer',
    );
    expect(backSwipeGesture?.enabled).toBe(true);
    expect(openDrawerGesture?.enabled).toBe(false);

    await act(async () => {
      backSwipeGesture?.onEnd?.({ translationX: 120, velocityX: 0 });
      await Promise.resolve();
    });

    expect(store.get(currentScreenAtom)).toBe('SubAgent');
    expect(store.get(navigationStackAtom)).toEqual([
      { screen: 'Main' },
      { screen: 'SubAgent', threadId: 'sub-agent-1' },
    ]);
    expect(store.get(drawerOpenAtom)).toBe(false);
    expect(store.get(drawerVisibleAtom)).toBe(false);
    expect(
      [...mockGestures].reverse().find((gesture) => gesture.testId === 'app-open-drawer')?.enabled,
    ).toBe(false);

    act(() => expect(mockBackHandler?.()).toBe(true));
    expect(store.get(currentScreenAtom)).toBe('Main');
    expect(store.get(navigationStackAtom)).toEqual([{ screen: 'Main' }]);
    act(() => tree.unmount());
  });

  it('keeps an old chat intact after a Git back swipe and subsequent session switch', async () => {
    const tree = await renderApp();
    const root = tree.root as Queryable;
    const hydratedChat = {
      id: 'git-swipe',
      title: 'Git swipe',
      status: 'complete',
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      statusUpdatedAt: profile.updatedAt,
      lastMessagePreview: 'ready',
      messages: [{ id: 'message-1', role: 'assistant', content: 'ready' }],
    };
    const gitChatShell = { ...hydratedChat, messages: [] };
    const gestureCount = mockGestures.length;

    await dispatch((s) => {
      s.set(chatContextChangedAtom, hydratedChat as unknown as Chat);
      s.set(openChatGitAtom, gitChatShell as unknown as Chat);
    });
    const backSwipeGesture = mockGestures
      .slice(gestureCount)
      .find((gesture) => gesture.testId === 'app-back-swipe');
    if (!backSwipeGesture) {
      throw new Error('Expected the Git back-swipe gesture');
    }
    expect(root.findAll((node) => node.props.testID === 'MainScreen')).not.toHaveLength(0);
    expect(root.findAll((node) => node.props.testID === 'GitScreen')).not.toHaveLength(0);

    mockSpringFinished = false;
    act(() => {
      backSwipeGesture.onStart?.({ translationX: 14 });
      backSwipeGesture.onUpdate?.({ translationX: 120 });
      backSwipeGesture.onEnd?.({ translationX: 120, velocityX: 0 });
    });
    expect(store.get(currentScreenAtom)).toBe('ChatGit');

    mockSpringFinished = true;
    await act(async () => {
      backSwipeGesture.onStart?.({ translationX: 14 });
      backSwipeGesture.onUpdate?.({ translationX: 120 });
      backSwipeGesture.onEnd?.({ translationX: 120, velocityX: 0 });
      await Promise.resolve();
    });
    expect(store.get(currentScreenAtom)).toBe('Main');
    expect(store.get(activeChatAtom)).toEqual(hydratedChat);
    expect(store.get(chatTransitionChatIdAtom)).toBeNull();
    expect(store.get(mainOpeningChatIdAtom)).toBeNull();
    expect(store.get(pendingMainChatIdAtom)).toBeNull();
    expect(store.get(pendingMainChatSnapshotAtom)).toBeNull();
    expect(root.findAll((node) => node.props.testID === 'GitScreen')).toHaveLength(0);
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Opening chat')).toHaveLength(
      0,
    );

    const nextChat = {
      ...hydratedChat,
      id: 'next-thread',
      title: 'Next thread',
      messages: [{ id: 'message-2', role: 'assistant', content: 'Next answer' }],
    };
    (mockApiInstances[0].peekChatShell as jest.Mock).mockReturnValueOnce(nextChat);
    await dispatch((s) => s.set(selectChatAtom, nextChat.id));
    expect(store.get(activeChatAtom)).toEqual(nextChat);
    expect(store.get(chatTransitionChatIdAtom)).toBeNull();
    expect(store.get(mainOpeningChatIdAtom)).toBeNull();
    expect(root.findAll((node) => node.props.accessibilityLabel === 'Opening chat')).toHaveLength(
      0,
    );

    act(() => tree.unmount());
  });

  it('closes the full-page drawer from its close control', async () => {
    const tree = await renderApp();
    await dispatch((s) => s.get(drawerCommandsAtom)?.toggleNavigation());
    expect(mockScreenProps.DrawerContent?.active).toBe(true);
    await dispatch((s) => s.set(closeDrawerAtom));
    expect(mockScreenProps.DrawerContent?.active).toBe(false);
    act(() => tree.unmount());
  });

  it('routes push responses, profile registration, websocket status, and app lifecycle', async () => {
    mockSnapshot = snapshot({
      registrations: [{ profileId: profile.id, registrationId: 'registration-1', token: null }],
    });
    const now = new Date('2026-07-20T12:00:00.000Z');
    jest.setSystemTime(now);
    const tree = await renderApp();
    expect(mockPushControllers[0].setProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: profile.id,
        registrationId: 'registration-1',
      }),
    );
    expect(mockSyncPushRegistration).toHaveBeenCalledWith(expect.anything(), store, profile.id);
    await act(async () => {
      mockWsStatusListeners.forEach((listener) => listener(false));
      mockWsStatusListeners.forEach((listener) => listener(true));
      await Promise.resolve();
    });
    await flushTimers();
    expect(mockApiInstances[0].primeChats as jest.Mock).toHaveBeenCalled();
    await act(async () => {
      mockPushControllers[0].navigate({ target: { threadId: 'push-thread' } });
      await Promise.resolve();
    });
    expect(store.get(pendingMainChatIdAtom)).toBe('push-thread');
    await act(async () => {
      mockNotificationResponseListeners[0]({ notification: 'tap' });
      jest.setSystemTime(new Date(now.getTime() + 1000));
      mockAppStateListeners[0]('background');
      jest.setSystemTime(new Date(now.getTime() + 2000));
      mockAppStateListeners[0]('active');
      await Promise.resolve();
    });
    expect(mockPushControllers[0].handle).toHaveBeenCalledWith({ notification: 'tap' });
    expect(mockSaveAutoStoreReviewState).toHaveBeenCalled();
    act(() => tree.unmount());
    expect(mockPushControllers[0].dispose).toHaveBeenCalled();
  });

  it('handles push retries, prefetch failures, and notifications without threads', async () => {
    mockSyncPushRegistration
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const tree = await renderApp();
    (mockApiInstances[0].primeChats as jest.Mock).mockRejectedValueOnce(
      new Error('prefetch failed'),
    );
    await act(async () => {
      mockPushControllers[0].navigate({ target: {} });
      mockWsStatusListeners.forEach((listener) => listener(false));
      mockWsStatusListeners.forEach((listener) => listener(true));
      await Promise.resolve();
    });
    await flushTimers(1000);
    expect(mockPushControllers[0].setProfile).toHaveBeenCalledWith(null);
    expect(mockSyncPushRegistration.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(store.get(pendingMainChatIdAtom)).toBeNull();
    act(() => tree.unmount());
  });

  it('absorbs best-effort persistence failures', async () => {
    mockSaveAutoStoreReviewState.mockRejectedValueOnce(new Error('storage full'));
    const tree = await renderApp();
    jest.setSystemTime(new Date(Date.now() + 1000));
    await act(async () => {
      mockAppStateListeners[0]('background');
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => tree.unmount());
  });

  it('covers empty cache selections and active-profile replacement', async () => {
    const secondProfile = { ...profile, id: 'profile-2', name: 'Second' };
    mockSnapshot = snapshot({ profiles: [profile, secondProfile] });
    const tree = await renderApp();
    await dispatch((s) => s.set(navigateAtom, 'Settings'));
    mockLoadChatSnapshotCache.mockResolvedValueOnce({
      version: 1,
      profileId: secondProfile.id,
      selectedChatId: 'missing',
      entries: [],
    });
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: secondProfile.id, profiles: [profile, secondProfile] },
    });
    await dispatch((s) => s.set(switchBridgeProfileAtom, secondProfile.id));
    mockLoadChatSnapshotCache.mockResolvedValueOnce(null);
    mockStore.dispatchDurable.mockResolvedValueOnce({
      bridgeProfiles: { activeProfileId: secondProfile.id, profiles: [secondProfile] },
    });
    await dispatch((s) => s.set(deleteBridgeProfileAtom, profile.id));
    expect(store.get(bridgeProfilesAtom)).toHaveLength(2);
    act(() => tree.unmount());
  });

  it('handles initial push responses and automatic review success, decline, and failure', async () => {
    mockGetInitialNotificationResponse.mockResolvedValueOnce({ notification: 'cold-start' });
    mockLoadAutoStoreReviewState.mockResolvedValueOnce({
      accumulatedForegroundMs: 600_000,
      automaticRequestAt: null,
    });
    mockIsAutoStoreReviewEligible.mockReturnValue(true);
    mockRequestNativeStoreReview.mockResolvedValueOnce(true);
    const success = await renderApp();
    await settleEffects();
    await flushTimers(600_000);
    await settleEffects();
    expect(mockPushControllers[0].handle).toHaveBeenCalledWith({ notification: 'cold-start' });
    expect(mockRequestNativeStoreReview).toHaveBeenCalled();
    expect(mockSaveAutoStoreReviewState).toHaveBeenCalledWith(
      expect.objectContaining({ automaticRequestAt: expect.any(String) }),
    );
    act(() => success.unmount());

    mockLoadAutoStoreReviewState.mockResolvedValueOnce({
      accumulatedForegroundMs: 600_000,
      automaticRequestAt: null,
    });
    mockRequestNativeStoreReview.mockResolvedValueOnce(false);
    const declined = await renderApp();
    await settleEffects();
    await flushTimers(600_000);
    await settleEffects();
    expect(mockRequestNativeStoreReview).toHaveBeenCalledTimes(2);
    act(() => declined.unmount());

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoadAutoStoreReviewState.mockResolvedValueOnce({
      accumulatedForegroundMs: 600_000,
      automaticRequestAt: null,
    });
    mockRequestNativeStoreReview.mockRejectedValueOnce('native failure');
    const failed = await renderApp();
    await settleEffects();
    await flushTimers(600_000);
    await settleEffects();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('native failure'));
    act(() => failed.unmount());
  });
});
