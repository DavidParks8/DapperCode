jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(() => null, { glyphMap: {} }),
}));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../../features/chat/message/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
  ToolInvocationRow: ({ invocation }: { invocation: { title: string } }) =>
    `tool:${invocation.title}`,
}));
jest.mock('../../features/chat/screen/AtomGlyph', () => ({ AtomGlyph: () => null }));
jest.mock('expo-crypto', () => {
  let counter = 0;
  return {
    randomUUID: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
  };
});

// The real runtime, provider, transport, and shell run over in-memory native services and a
// scripted model, so lifecycle and status flow through every layer the app uses.
let mockLlama: FakeLlama;
let mockNative: FakeOnDeviceNative;
jest.mock('../../features/on-device/native/services', () => ({
  getOnDeviceNativeServices: () => mockNative.native,
}));
jest.mock('../../features/on-device/runtime/expoNetwork', () => ({
  createExpoNetwork: () => {
    const { FakeNetwork } = jest.requireActual<{ FakeNetwork: new () => unknown }>(
      '../../features/on-device/runtime/testing',
    );
    return new FakeNetwork();
  },
}));
jest.mock('../../features/on-device/models/engine', () => ({
  ...jest.requireActual<object>('../../features/on-device/models/engine'),
  loadNativeModelContext: (...args: Parameters<LocalContextLoader>) => mockLlama.loader(...args),
}));

import { useAtomValue } from 'jotai';
import { AppState, FlatList, Text, TextInput, type AppStateStatus } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { getMessageText } from '@bridge/messages';
import type { ChatMessage } from '@bridge/types/types';
import type { LocalContextLoader } from '../../features/on-device/models/engine';
import {
  createFakeOnDeviceNative,
  FakeLlama,
  type FakeOnDeviceNative,
} from '../../features/on-device/runtime/testing';
import { MainScreen } from '../../features/chat/screen/MainScreen';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { DrawerContent } from '@shell/navigation/DrawerContent';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { createDefaultAppStateData } from '@shell/state/appState';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import {
  activeProfileIsLocalAtom,
  apiClientAtom,
  localProfileAvailableAtom,
} from '@shell/state/bridge/atoms';
import { localRuntimeAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createTestStore, withAppStore } from '@shell/state/testing';
import { LocalRuntimeHost } from './LocalRuntimeHost';

const QWEN = 'qwen3-1.7b-q4-k-m';

type Node = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Node) => boolean): Node[];
  findAllByType(type: unknown): Node[];
};

const appStateHandlers = new Map<string, Set<(state?: AppStateStatus) => void>>();

async function flush(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

/** Lets coalesced runtime emits, journal writes, and transport events land. */
async function settle(ms = 300): Promise<void> {
  for (let step = 0; step < 4; step += 1) {
    await act(async () => {
      await flush();
      jest.advanceTimersByTime(ms / 4);
      await flush();
    });
  }
}

/** Drives the scripted model inside `act`, as native callbacks would arrive. */
async function drive(step: () => void): Promise<void> {
  await act(async () => {
    step();
    await flush();
  });
  await settle();
}

function changeAppState(state: AppStateStatus): Promise<void> {
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
  act(() => {
    for (const handler of appStateHandlers.get('change') ?? []) {
      handler(state);
    }
  });
  return settle();
}

function transcript(root: Node): string[] {
  const items = (root.findAllByType(FlatList)[0]?.props['data'] ?? []) as {
    message?: ChatMessage;
  }[];
  return items
    .map((item) => (item.message ? getMessageText(item.message) : ''))
    .filter((text) => text.length > 0);
}

function labeled(root: Node, label: string): Node | undefined {
  return root.findAll((node) => node.props['accessibilityLabel'] === label)[0];
}

function texts(root: Node): string[] {
  return root
    .findAllByType(Text)
    .flatMap((node) =>
      ([] as unknown[])
        .concat(node.props['children'])
        .filter((child): child is string => typeof child === 'string'),
    );
}

function hasText(root: Node, text: string): boolean {
  return texts(root).some((entry) => entry.includes(text));
}

/** The drawer footer, which reports the local agent's status. */
function drawerStatus(root: Node): string | undefined {
  const footer = root.findAll(
    (node) =>
      typeof node.props['accessibilityLabel'] === 'string' &&
      node.props['accessibilityLabel'].startsWith('On this iPhone, ') &&
      typeof node.props['onPress'] === 'function',
  )[0];
  const label = footer?.props['accessibilityLabel'] as string | undefined;
  return label?.slice('On this iPhone, '.length, -'. Open settings'.length);
}

async function submit(root: Node, text: string): Promise<void> {
  const input = root
    .findAllByType(TextInput)
    .find((node) => node.props['accessibilityLabel'] === 'Message');
  if (!input) {
    throw new Error('Missing composer');
  }
  await act(async () => {
    (input.props['onChangeText'] as (value: string) => void)(text);
    await flush();
  });
  const composer = root.findAll(
    (node) =>
      typeof node.props['onSubmit'] === 'function' &&
      typeof node.props['onChangeText'] === 'function',
  )[0];
  await act(async () => {
    (composer?.props['onSubmit'] as () => void)();
    await flush();
  });
  await settle();
}

function composerText(root: Node): unknown {
  return root
    .findAllByType(TextInput)
    .find((node) => node.props['accessibilityLabel'] === 'Message')?.props['value'];
}

/** The profile's screens mount once its clients exist, as the profile route boundary does. */
function ProfileScreens() {
  const api = useAtomValue(apiClientAtom);
  const local = useAtomValue(activeProfileIsLocalAtom);
  return api && local ? (
    <>
      <DrawerContent active />
      <MainScreen />
    </>
  ) : null;
}

async function press(root: Node, label: string): Promise<void> {
  const node = labeled(root, label);
  if (!node) {
    throw new Error(`Missing ${label}`);
  }
  await act(async () => {
    (node.props['onPress'] as () => void)();
    await flush();
  });
  await settle();
}

function setActiveProfile(store: ReturnType<typeof createTestStore>, activeProfileId: string) {
  const snapshot = store.get(appStateSnapshotAtom);
  store.set(appStateSnapshotAtom, {
    ...snapshot,
    data: {
      ...snapshot.data,
      bridgeProfiles: { ...snapshot.data.bridgeProfiles, activeProfileId },
    },
  });
}

async function renderShell() {
  mockLlama = new FakeLlama();
  mockNative = createFakeOnDeviceNative(mockLlama, { downloaded: [QWEN] });
  const data = createDefaultAppStateData();
  data.bridgeProfiles = {
    activeProfileId: LOCAL_PROFILE_ID,
    profiles: [
      {
        id: 'bridge-1',
        name: 'Desk',
        bridgeUrl: 'https://desk.test',
        bridgeToken: 'token',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const store = createTestStore({ data });
  store.set(localProfileAvailableAtom, true);
  store.set(drawerCommandsAtom, {
    closeDrawer: () => undefined,
    toggleNavigation: () => undefined,
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
            <LocalRuntimeHost />
            <ProfileScreens />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await flush();
  });
  for (let attempt = 0; attempt < 20 && !store.get(localRuntimeAtom); attempt += 1) {
    await settle();
  }
  const runtime = store.get(localRuntimeAtom);
  if (!runtime) {
    throw new Error('The local runtime did not start');
  }
  await settle();
  return { tree: tree!, root: tree!.root as Node, store, runtime };
}

describe('On this iPhone through the real runtime, transport, and shell', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    appStateHandlers.clear();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
      const handlers = appStateHandlers.get(type) ?? new Set();
      handlers.add(handler as (state?: AppStateStatus) => void);
      appStateHandlers.set(type, handlers);
      return { remove: () => handlers.delete(handler as (state?: AppStateStatus) => void) };
    });
  });

  afterEach(async () => {
    mockLlama.holdLoads = false;
    mockLlama.holdCompletions = false;
    mockLlama.holdStops = false;
    await drive(() => mockLlama.finishLoad());
    await drive(() => mockLlama.finishStop());
    await drive(() => mockLlama.finishCompletion());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps a turn and its model through inactive states, stops on background, and warms on return', async () => {
    const { tree, root, runtime } = await renderShell();
    expect(drawerStatus(root)).toBe('Qwen3 1.7B Q4_K_M · loads when you send');

    mockLlama.holdLoads = true;
    mockLlama.holdCompletions = true;
    mockLlama.reply({ content: 'The workspace holds a demo app.' });
    await submit(root, 'Explain the workspace');
    await drive(() => mockLlama.loadProgress(42));
    expect(hasText(root, 'Loading Qwen3 1.7B')).toBe(true);
    expect(hasText(root, ' · 42%')).toBe(true);
    expect(drawerStatus(root)).toBe('Loading Qwen3 1.7B Q4_K_M · 42%');
    expect(labeled(root, 'Stop agent')).toBeTruthy();

    // Control Center, the app switcher, Face ID, and calls make the app inactive, not background.
    await changeAppState('inactive');
    expect(mockLlama.loadPending).toBe(true);
    await drive(() => mockLlama.finishLoad());
    await changeAppState('active');
    expect(drawerStatus(root)).toBe('Generating on this iPhone');
    expect(hasText(root, 'Generating')).toBe(true);
    await changeAppState('inactive');
    await drive(() => mockLlama.stream('The workspace'));
    await drive(() => mockLlama.finishCompletion());
    await changeAppState('active');

    expect(mockLlama.stops).toBe(0);
    expect(mockLlama.releases).toBe(0);
    expect(transcript(root)).toEqual(
      expect.arrayContaining(['Explain the workspace', 'The workspace holds a demo app.']),
    );
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(drawerStatus(root)).toBe('Qwen3 1.7B Q4_K_M · ready on this iPhone');
    const [thread] = runtime.threads.list();
    expect(thread?.status).toBe('complete');

    // A real background transition stops the turn (preserving its text) and unloads the model.
    mockLlama.reply({ content: 'Partial answer that never finishes' });
    await submit(root, 'Keep going');
    await drive(() => mockLlama.stream('Partial answer'));
    expect(labeled(root, 'Stop agent')).toBeTruthy();
    await changeAppState('background');
    expect(mockLlama.stops).toBe(1);
    expect(mockLlama.resident.size).toBe(0);
    expect(runtime.threads.get(thread!.id).status).toBe('interrupted');
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(transcript(root)).toContain('Partial answer');

    // Returning to the foreground warms the model again without replaying the turn.
    mockLlama.holdCompletions = false;
    await changeAppState('active');
    expect(mockLlama.loads.map((load) => load.modelId)).toEqual([QWEN, QWEN]);
    expect(drawerStatus(root)).toBe('Loading Qwen3 1.7B Q4_K_M · 0%');
    await drive(() => mockLlama.finishLoad());
    expect(runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId: QWEN });
    expect(runtime.threads.get(thread!.id).status).toBe('interrupted');
    expect(drawerStatus(root)).toBe('Qwen3 1.7B Q4_K_M · ready on this iPhone');
    act(() => tree.unmount());
  });

  it('labels stopping and load errors in the transcript, composer, and drawer', async () => {
    const { tree, root, runtime } = await renderShell();
    mockLlama.holdCompletions = true;
    mockLlama.holdStops = true;
    await submit(root, 'Write a long answer');
    await drive(() => mockLlama.stream('Working on it'));
    expect(drawerStatus(root)).toBe('Generating on this iPhone');

    await act(async () => {
      (labeled(root, 'Stop agent')!.props['onPress'] as () => void)();
      await flush();
    });
    await settle();
    expect(drawerStatus(root)).toBe('Stopping — waiting for current work to settle');
    expect(hasText(root, 'Stopping')).toBe(true);
    await drive(() => mockLlama.finishStop());
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(hasText(root, 'Stopping')).toBe(false);
    expect(runtime.threads.list()[0]?.status).toBe('interrupted');

    // A model that cannot load reports why everywhere, and the unsent message stays in the draft.
    await act(async () => {
      await runtime.unloadModel();
    });
    mockLlama.holdLoads = true;
    await submit(root, 'Try again');
    await drive(() => mockLlama.failLoad('Not enough memory to load Qwen3 1.7B.'));
    expect(hasText(root, 'Not enough memory to load Qwen3 1.7B.')).toBe(true);
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(drawerStatus(root)).toBe("Couldn't load Qwen3 1.7B Q4_K_M");
    expect(composerText(root)).toBe('Try again');
    act(() => tree.unmount());
  });

  it('runs a model push only after Allow on the shared banner, and retries a failed turn in place', async () => {
    const { tree, root, runtime } = await renderShell();
    mockLlama.reply(
      { toolCalls: [{ name: 'git_push', arguments: {} }] },
      { content: 'Pushed main.' },
    );
    await submit(root, 'Push my branch');
    expect(hasText(root, 'Push the current branch to its remote')).toBe(true);
    expect(drawerStatus(root)).toBe(
      'Waiting for your approval · Push the current branch to its remote',
    );
    expect(mockNative.calls).not.toContain('pushWorkspaceGit:["ws-one"]');

    await press(root, 'Allow');
    expect(mockNative.calls).toContain('pushWorkspaceGit:["ws-one"]');
    expect(labeled(root, 'Allow')).toBeUndefined();
    expect(transcript(root)).toContain('Pushed main.');
    const [thread] = runtime.threads.list();
    expect(thread?.status).toBe('complete');

    // A generation failure is shown in the composer with Retry, which continues the same turn.
    mockLlama.reply({ fail: 'The native generation failed.' }, { content: 'Second try worked.' });
    await submit(root, 'Summarize what you did');
    expect(hasText(root, 'The native generation failed.')).toBe(true);
    expect(drawerStatus(root)).toBe('Qwen3 1.7B Q4_K_M · ready on this iPhone');
    await press(root, 'Retry turn');
    expect(transcript(root)).toContain('Second try worked.');
    expect(hasText(root, 'The native generation failed.')).toBe(false);
    expect(labeled(root, 'Retry turn')).toBeUndefined();
    expect(
      runtime.threads
        .get(thread!.id)
        .messages.filter((message) => message.content === 'Summarize what you did'),
    ).toHaveLength(1);
    expect(mockLlama.loads).toHaveLength(1);
    act(() => tree.unmount());
  });

  it('disposes the runtime when switching to a desktop profile and restores chats on return', async () => {
    const { tree, root, store, runtime } = await renderShell();
    mockLlama.holdCompletions = true;
    await submit(root, 'Explain the workspace');
    await drive(() => mockLlama.stream('The workspace'));
    const [thread] = runtime.threads.list();
    expect(labeled(root, 'Stop agent')).toBeTruthy();

    // Leaving the profile settles its work: the run stops and the model is released.
    await act(async () => {
      setActiveProfile(store, 'bridge-1');
      await flush();
    });
    await settle();
    expect(store.get(localRuntimeAtom)).toBeNull();
    expect(mockLlama.stops).toBe(1);
    expect(mockLlama.resident.size).toBe(0);
    expect(drawerStatus(tree.root as Node)).toBeUndefined();

    mockLlama.holdCompletions = false;
    await act(async () => {
      setActiveProfile(store, LOCAL_PROFILE_ID);
      await flush();
    });
    for (let attempt = 0; attempt < 20 && !store.get(localRuntimeAtom); attempt += 1) {
      await settle();
    }
    const restored = store.get(localRuntimeAtom);
    expect(restored).not.toBe(runtime);
    expect(restored?.threads.get(thread!.id)).toMatchObject({ status: 'interrupted' });
    await settle();
    const rows = (tree.root as Node).findAll(
      (node) => node.props['testID'] === `drawer-chat-row-${thread!.id}`,
    );
    expect(rows.length).toBeGreaterThan(0);
    act(() => tree.unmount());
  });
});
