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
  type FakeNativeOptions,
  type FakeOnDeviceNative,
} from '../../features/on-device/runtime/testing';
import { MainScreen } from '../../features/chat/screen/MainScreen';
import { ToolInvocationRow } from '../../features/chat/message/ChatMessage';
import { LocalProfileSection } from '../../features/settings/LocalProfileSection';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { DrawerContent } from '@shell/navigation/DrawerContent';
import { drawerCommandsAtom } from '@shell/state/drawer/atoms';
import { createDefaultAppStateData } from '@shell/state/appState';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import {
  activeProfileIsLocalAtom,
  apiClientAtom,
  localProfileAvailableAtom,
  wsClientAtom,
} from '@shell/state/bridge/atoms';
import { localRuntimeAtom } from '@shell/state/local/atoms';
import { activeChatAtom } from '@shell/state/chat/atoms';
import { TURN_RETRY_METHOD } from '../../features/chat/turn/turnRetry';
import {
  approvalModeAtom,
  defaultStartCwdAtom,
  showToolCallsAtom,
} from '@shell/state/appState/settings';
import {
  deleteManagedWorkspaceAtom,
  renameManagedWorkspaceAtom,
  selectManagedWorkspaceAtom,
} from '../../features/workspace/state/managedWorkspaces';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createTestStore, withAppStore } from '@shell/state/testing';
import { LocalRuntimeHost } from './LocalRuntimeHost';
import { selectChatAtom, startNewChatAtom } from '@shell/navigation/actions';
import { toRecord } from '@shared/runtimeValidation';
import { SelectionSheet, type SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { emptyLocalPreferences } from '../../features/on-device/runtime/preferences';
import { localModelDefinition } from '../../features/on-device/models/catalog';
import { modelMemoryBytes } from '../../features/on-device/models/memory';
import { fileSystemMock } from '@shared/testing/expoFileSystemMock';
import { WORKSPACE_HOST_METHODS } from '../../features/workspace/api/protocol';
import { ChatInput } from '../../features/chat/composer/ChatInput';
import { ActivityEvent } from '../../features/chat/transcript/ActivityEvent';
import { pendingUserInputRequestAtom } from '../../features/chat/state/turn';
import { storedLocalThread } from '../../features/on-device/runtime/testing';
import { WorkflowCard } from '../../features/chat/workflow/Workflow';

const QWEN = 'qwen3-1.7b-q4-k-m';
const TRANSITION_A = 'bonsai-2-2b-q2-0';
const TRANSITION_B = 'qwen35-0.8b-q4-0';
const ASK = {
  name: 'ask_user',
  arguments: {
    questions: [
      {
        id: 'theme',
        header: 'Theme',
        question: 'Choose a theme',
        options: [
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ],
      },
      {
        id: 'languages',
        header: 'Languages',
        question: 'Choose languages',
        multiSelect: true,
        options: [
          { value: 'ts', label: 'TypeScript' },
          { value: 'rust', label: 'Rust' },
        ],
      },
      { id: 'notes', header: 'Notes', question: 'Anything else?' },
    ],
  },
};

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

function deniedPushCopies(root: Node): number {
  const failedTool = root
    .findAllByType(ToolInvocationRow)
    .map((node) => toRecord(node.props['invocation']))
    .find((value) => value?.['status'] === 'failed');
  const lines = failedTool?.['textLines'];
  if (!Array.isArray(lines)) {
    throw new Error('Expected the rendered denied push output.');
  }
  return lines.filter(
    (line: unknown) => typeof line === 'string' && line.includes('The user declined'),
  ).length;
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

function expectSettledControls(root: Node): void {
  expect(labeled(root, 'Stop agent')).toBeUndefined();
  expect(labeled(root, 'Stop request')).toBeUndefined();
  expect(root.findAllByType(ChatInput)[0]?.props).toMatchObject({
    showStopButton: false,
    isStopping: false,
    isLoading: false,
    submitDisabled: false,
  });
  expect(root.findAllByType(ActivityEvent).some((node) => node.props['tone'] === 'running')).toBe(
    false,
  );
}

function modelPickerOption(root: Node, modelId: string): SelectionSheetOption {
  for (const sheet of root.findAllByType(SelectionSheet)) {
    const option = (sheet.props['options'] as SelectionSheetOption[]).find(
      (entry) => entry.key === modelId,
    );
    if (option) {
      return option;
    }
  }
  throw new Error(`Missing model picker option: ${modelId}`);
}

/** The profile's screens mount once its clients exist, as the profile route boundary does. */
function ProfileScreens() {
  const api = useAtomValue(apiClientAtom);
  const local = useAtomValue(activeProfileIsLocalAtom);
  return api && local ? (
    <>
      <DrawerContent active />
      <MainScreen />
      <LocalProfileSection />
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

async function renderShell(options: FakeNativeOptions = {}) {
  mockLlama = new FakeLlama();
  mockNative = createFakeOnDeviceNative(mockLlama, { downloaded: [QWEN], ...options });
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

async function renderTransitionChat(options: FakeNativeOptions = {}) {
  const shell = await renderShell({
    downloaded: [TRANSITION_A, TRANSITION_B],
    files: { 'ws-one:seed.txt': 'alpha\n' },
    documents: {
      'preferences.json': JSON.stringify({
        ...emptyLocalPreferences(),
        modelId: TRANSITION_A,
        workspaceId: 'ws-one',
        author: { name: 'Transition fixture', email: 'transition@example.invalid' },
      }),
    },
    ...options,
  });
  mockLlama.reply(
    { toolCalls: [{ name: 'read_file', arguments: { path: 'seed.txt' } }] },
    { content: 'Read alpha.' },
  );
  await submit(shell.root, 'Read seed.txt.');
  const [thread] = shell.runtime.threads.list();
  if (!thread) {
    throw new Error('Expected the original A conversation.');
  }
  return { ...shell, thread, history: structuredClone(thread.messages) };
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
    mockLlama.holdReleases = false;
    await drive(() => mockLlama.finishRelease());
    await drive(() => mockLlama.finishLoad());
    await drive(() => mockLlama.finishStop());
    await drive(() => mockLlama.finishCompletion());
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('waits for real multi-question choice, multiselect and free text answers then resumes generation', async () => {
    const { tree, root, runtime, store } = await renderShell();
    const api = store.get(apiClientAtom)!;
    await act(async () => {
      store.set(approvalModeAtom, 'none');
      await api.setApprovalPolicy('never');
    });
    mockLlama.reply({ toolCalls: [ASK] }, { content: 'Applied your choices.' });
    await submit(root, 'Ask me before deciding.');
    const request = runtime.loop.snapshot().userInput!;
    expect(request.questions).toHaveLength(3);
    expect(await api.listPendingUserInputs()).toEqual([request]);
    expect(mockLlama.executions).toHaveLength(1);
    expect(drawerStatus(root)).toContain('Clarification needed');
    expect(labeled(root, 'Light')?.props['accessibilityRole']).toBe('radio');
    expect(labeled(root, 'Rust')?.props['accessibilityRole']).toBe('checkbox');
    expect(root.findAllByType(ActivityEvent).some((node) => node.props['tone'] === 'running')).toBe(
      false,
    );
    expect(labeled(root, 'Stop agent')).toBeDefined();
    expect(root.findAllByType(ChatInput)[0]?.props).toMatchObject({
      showStopButton: true,
      isStopping: false,
      isLoading: false,
    });
    await press(root, 'Submit answers');
    expect(hasText(root, 'Please answer "Theme"')).toBe(true);
    expect(runtime.loop.snapshot().phase).toBe('input');
    await press(root, 'Light');
    await press(root, 'TypeScript');
    await press(root, 'Rust');
    await press(root, 'TypeScript');
    expect(labeled(root, 'TypeScript')?.props['accessibilityState']).toMatchObject({
      checked: false,
    });
    expect(labeled(root, 'Rust')?.props['accessibilityState']).toMatchObject({ checked: true });
    const notes = labeled(root, 'Notes')!;
    await act(async () => {
      (notes.props['onChangeText'] as (value: string) => void)('Keep it accessible.');
      await flush();
    });
    mockLlama.holdCompletions = true;
    await press(root, 'Submit answers');
    expect(runtime.loop.snapshot().phase).toBe('generating');
    expect(store.get(pendingUserInputRequestAtom)).toBeNull();
    expect(await api.listPendingUserInputs()).toEqual([]);
    expect(labeled(root, 'Stop request')).toBeUndefined();
    expect(labeled(root, 'Stop agent')).toBeDefined();
    expect(hasText(root, 'Generating')).toBe(true);
    const thread = runtime.threads.list()[0]!;
    expect(
      JSON.parse(thread.messages.find((message) => message.tool?.name === 'ask_user')!.content),
    ).toEqual({ answers: { theme: 'light', languages: ['rust'], notes: 'Keep it accessible.' } });
    await expect(api.resolveUserInput(request.requestId, { answers: {} })).rejects.toThrow(
      'no longer pending',
    );
    await drive(() => mockLlama.finishCompletion());
    expect(transcript(root)).toContain('Applied your choices.');
    expectSettledControls(root);
    act(() => tree.unmount());
  });

  it.each(['cancel', 'decline'] as const)(
    'returns an explicit %s error to the model, not an assumed answer',
    async (action) => {
      const { tree, root, runtime } = await renderShell();
      mockLlama.reply({ toolCalls: [ASK] }, { content: 'I will wait for your direction.' });
      await submit(root, 'Ask me.');
      mockLlama.holdCompletions = true;
      await press(root, action === 'cancel' ? 'Cancel request' : 'Decline request');
      expect(runtime.loop.snapshot().phase).toBe('generating');
      const tool = runtime.threads
        .list()[0]!
        .messages.find((message) => message.tool?.name === 'ask_user')!;
      expect(tool.tool?.status).toBe('failed');
      expect(JSON.parse(tool.content)).toEqual({
        error: expect.stringContaining('No answer was provided'),
      });
      expect(labeled(root, 'Stop request')).toBeUndefined();
      await drive(() => mockLlama.finishCompletion());
      expectSettledControls(root);
      act(() => tree.unmount());
    },
  );

  it('keeps the next question and draft intact when an older answer acknowledgement fails late', async () => {
    const { tree, root, runtime, store } = await renderShell();
    const api = store.get(apiClientAtom)!;
    const question = {
      name: 'ask_user',
      arguments: { questions: [{ id: 'notes', header: 'Notes', question: 'What next?' }] },
    };
    mockLlama.reply(
      { toolCalls: [question] },
      { toolCalls: [question] },
      { content: 'Both answered.' },
    );
    await submit(root, 'Ask twice.');
    const first = runtime.loop.snapshot().userInput!;
    let rejectOld!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, reject) => {
      rejectOld = reject;
    });
    const original = api.resolveUserInput.bind(api);
    jest.spyOn(api, 'resolveUserInput').mockImplementationOnce(async (...args) => {
      await original(...args);
      return gate;
    });
    await act(async () => {
      (labeled(root, 'Notes')!.props['onChangeText'] as (value: string) => void)('First answer');
    });
    await press(root, 'Submit answers');
    const second = runtime.loop.snapshot().userInput!;
    expect(second.requestId).not.toBe(first.requestId);
    await act(async () => {
      (labeled(root, 'Notes')!.props['onChangeText'] as (value: string) => void)('Second answer');
      rejectOld(new Error('Old acknowledgement failed'));
      await flush();
    });
    await settle();
    expect(store.get(pendingUserInputRequestAtom)?.requestId).toBe(second.requestId);
    expect(labeled(root, 'Notes')?.props['value']).toBe('Second answer');
    expect(hasText(root, 'Old acknowledgement failed')).toBe(false);
    expect(labeled(root, 'Submit answers')?.props['disabled']).toBe(false);
    await expect(
      api.resolveUserInput(first.requestId, { answers: { notes: 'stale' } }),
    ).rejects.toThrow('no longer pending');
    await press(root, 'Submit answers');
    expect(transcript(root)).toContain('Both answered.');
    expect(
      runtime.threads.list()[0]?.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expectSettledControls(root);
    act(() => tree.unmount());
  });

  it('keeps a failed answer delivery pending and enables an explicit retry', async () => {
    const { tree, root, runtime, store } = await renderShell();
    mockLlama.reply(
      {
        toolCalls: [
          {
            name: 'ask_user',
            arguments: { questions: [{ id: 'notes', header: 'Notes', question: 'What next?' }] },
          },
        ],
      },
      { content: 'Answer received.' },
    );
    await submit(root, 'Ask me.');
    const requestId = runtime.loop.snapshot().userInput!.requestId;
    jest
      .spyOn(store.get(apiClientAtom)!, 'resolveUserInput')
      .mockRejectedValueOnce(new Error('Answer delivery failed'));
    await act(async () => {
      (labeled(root, 'Notes')!.props['onChangeText'] as (value: string) => void)('Please proceed');
    });
    await press(root, 'Submit answers');
    expect(hasText(root, 'Answer delivery failed')).toBe(true);
    expect(labeled(root, 'Submit answers')?.props['disabled']).toBe(false);
    expect(runtime.loop.snapshot().userInput?.requestId).toBe(requestId);
    expect(mockLlama.executions).toHaveLength(1);
    expect(labeled(root, 'Stop agent')).toBeDefined();
    await press(root, 'Submit answers');
    expect(transcript(root)).toContain('Answer received.');
    expectSettledControls(root);
    act(() => tree.unmount());
  });

  it('rejects invalid model question/task arguments without waiting or mutating durable tasks', async () => {
    const { tree, root, runtime, store } = await renderShell();
    await act(async () => {
      store.set(approvalModeAtom, 'all');
      await store.get(apiClientAtom)!.setApprovalPolicy('untrusted');
    });
    mockLlama.reply(
      { toolCalls: [{ name: 'ask_user', arguments: { questions: [] } }] },
      {
        toolCalls: [
          {
            name: 'todo_write',
            arguments: { todos: [{ id: '../bad', content: 'No', status: 'pending' }] },
          },
        ],
      },
      { content: 'I could not run those requests.' },
    );
    await submit(root, 'Validate requests.');
    expect(labeled(root, 'Allow')).toBeUndefined();
    expect(labeled(root, 'Submit answers')).toBeUndefined();
    expect(runtime.threads.list()[0]?.tasks).toBeUndefined();
    const results = runtime.threads.list()[0]!.messages.filter((message) => message.tool);
    expect(results.map((message) => message.tool?.status)).toEqual(['failed', 'failed']);
    expect(results.every((message) => 'error' in JSON.parse(message.content))).toBe(true);
    expectSettledControls(root);
    act(() => tree.unmount());
  });

  it.each(['stop', 'background', 'profile', 'reload', 'delete'] as const)(
    'settles a pending question on %s and fences stale replies without replay',
    async (action) => {
      const { tree, root, runtime, store } = await renderShell();
      mockLlama.reply({ toolCalls: [ASK] });
      await submit(root, 'Ask before acting.');
      const request = runtime.loop.snapshot().userInput!;
      const api = store.get(apiClientAtom)!;
      const id = request.threadId;
      if (action === 'stop') {
        await press(root, 'Stop request');
      } else if (action === 'background') {
        await changeAppState('background');
      } else if (action === 'delete') {
        await act(async () => {
          await api.deleteChat(id);
        });
        await settle();
      } else if (action === 'profile') {
        act(() => setActiveProfile(store, 'bridge-1'));
        await settle();
      } else {
        act(() => tree.unmount());
        await settle();
      }
      expect(runtime.loop.snapshot().phase).toBe('idle');
      expect(runtime.loop.snapshot().userInput).toBeUndefined();
      expect(() => runtime.loop.resolveUserInput(request.requestId, { answers: {} })).toThrow(
        'no longer pending',
      );
      expect(mockLlama.executions).toHaveLength(1);
      if (action === 'delete') {
        expect(runtime.threads.find(id)).toBeNull();
        expect(storedLocalThread(mockNative.documents, id)).toBeNull();
      } else {
        expect(storedLocalThread(mockNative.documents, id)?.status).toBe('interrupted');
      }
      if (action === 'profile' || action === 'background') {
        if (action === 'profile') {
          act(() => setActiveProfile(store, LOCAL_PROFILE_ID));
          await settle();
        } else {
          await changeAppState('active');
        }
        expect(store.get(localRuntimeAtom)?.loop.snapshot().phase).toBe('idle');
      }
      if (action === 'reload') {
        const restarted = await renderShell({
          documents: Object.fromEntries(mockNative.documents),
        });
        expect(restarted.runtime.threads.get(id).status).toBe('interrupted');
        expect(restarted.runtime.loop.snapshot().userInput).toBeUndefined();
        expect(await restarted.store.get(apiClientAtom)!.listPendingUserInputs()).toEqual([]);
        act(() => restarted.tree.unmount());
      } else {
        await settle();
        expectSettledControls(root);
        expect(store.get(pendingUserInputRequestAtom)).toBeNull();
        act(() => tree.unmount());
      }
    },
  );

  it('persists and renders stable task updates through interruption, profile recovery and deletion', async () => {
    const { tree, root, runtime, store } = await renderShell();
    const todo = { id: 'build', content: 'Build accessible controls', status: 'in_progress' };
    mockLlama.reply(
      { toolCalls: [{ name: 'todo_write', arguments: { todos: [todo] } }] },
      {
        toolCalls: [
          { name: 'todo_write', arguments: { todos: [{ ...todo, status: 'completed' }] } },
        ],
      },
      { toolCalls: [ASK] },
    );
    await submit(root, 'Track the work and ask before finishing.');
    const thread = runtime.threads.list()[0]!;
    expect(thread.tasks).toEqual([{ ...todo, status: 'completed' }]);
    expect(storedLocalThread(mockNative.documents, thread.id)?.tasks).toEqual(thread.tasks);
    expect(root.findAllByType(WorkflowCard).map((node) => node.props['plan'])).toEqual([
      expect.objectContaining({ steps: [{ step: todo.content, status: 'completed' }] }),
    ]);
    if (root.findAllByType(WorkflowCard)[0]?.props['collapsed']) {
      await press(root, `Execution, ${todo.content}`);
    }
    expect(hasText(root, '1/1 done')).toBe(true);
    expect(thread.status).toBe('running');
    expect(labeled(root, 'Stop request')).toBeDefined();
    await press(root, 'Stop request');
    expectSettledControls(root);
    act(() => setActiveProfile(store, 'bridge-1'));
    await settle();
    act(() => setActiveProfile(store, LOCAL_PROFILE_ID));
    await settle();
    const recovered = store.get(localRuntimeAtom)!;
    expect(recovered.threads.get(thread.id).tasks).toEqual(thread.tasks);
    const api = store.get(apiClientAtom)!;
    expect((await api.getChat(thread.id)).latestPlan?.steps).toEqual([
      { step: todo.content, status: 'completed' },
    ]);
    mockLlama.reply(
      {
        toolCalls: [
          { name: 'todo_write', arguments: { todos: [{ ...todo, status: 'completed' }] } },
        ],
      },
      { toolCalls: [{ name: 'todo_read', arguments: {} }] },
      { content: 'Verified the result.' },
    );
    await act(async () => {
      await recovered.retryTurn(thread.id);
    });
    await settle();
    expect(recovered.threads.get(thread.id).tasks).toHaveLength(1);
    expect(
      recovered.threads.get(thread.id).messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    await act(async () => {
      await api.deleteChat(thread.id);
    });
    await settle();
    expect(storedLocalThread(mockNative.documents, thread.id)).toBeNull();
    expect(
      mockNative.calls.some((call) => /writeWorkspaceFile|writeWorkspaceConfig/.test(call)),
    ).toBe(false);
    act(() => tree.unmount());
  });

  it('reports a task storage failure as a failed tool and recovers the desired list through persistence retry', async () => {
    const { tree, root, runtime } = await renderShell();
    const original = mockNative.native.writeRuntimeDocument;
    const write = jest
      .spyOn(mockNative.native, 'writeRuntimeDocument')
      .mockImplementation(async (name, content) => {
        if (content.includes('"tasks"')) {
          throw new Error('Task storage unavailable');
        }
        return original(name, content);
      });
    const todos = [{ id: 'verify', content: 'Verify first', status: 'pending' }];
    mockLlama.reply(
      { toolCalls: [{ name: 'todo_write', arguments: { todos } }] },
      { content: 'The task list could not be saved.' },
    );
    await submit(root, 'Track this.');
    const thread = runtime.threads.list()[0]!;
    const result = thread.messages.find((message) => message.tool?.name === 'todo_write')!;
    expect(result.tool?.status).toBe('failed');
    expect(JSON.parse(result.content)).toEqual({ error: 'Task storage unavailable' });
    expect(runtime.issues().some((issue) => issue.kind === 'persistence')).toBe(true);
    expect(hasText(root, 'Task storage unavailable')).toBe(true);
    expect(storedLocalThread(mockNative.documents, thread.id)?.tasks).toBeUndefined();
    write.mockRestore();
    await act(async () => {
      await runtime.retryPersistence();
    });
    await settle();
    expect(storedLocalThread(mockNative.documents, thread.id)?.tasks).toEqual(todos);
    expect(runtime.issues().some((issue) => issue.kind === 'persistence')).toBe(false);
    expectSettledControls(root);
    act(() => tree.unmount());
  });

  it.each([false, true])(
    'switches an existing chat to a newly downloaded model on Send, without explicit Load (held ack %s)',
    async (heldAck) => {
      const { tree, root, runtime, store } = await renderShell({
        downloaded: [TRANSITION_A],
        files: { 'ws-one:seed.txt': 'alpha\n' },
        documents: {
          'preferences.json': JSON.stringify({
            ...emptyLocalPreferences(),
            modelId: TRANSITION_A,
            workspaceId: 'ws-one',
          }),
        },
      });
      mockLlama.reply(
        { toolCalls: [{ name: 'read_file', arguments: { path: 'seed.txt' } }] },
        { content: 'Read alpha.' },
      );
      await submit(root, 'Read seed.txt.');
      const [existing] = runtime.threads.list();
      if (!existing) {
        throw new Error('Expected the existing A conversation.');
      }
      const history = structuredClone(existing.messages);
      expect(existing.modelId).toBe(TRANSITION_A);
      expect(runtime.models.snapshot()).toMatchObject({ modelId: TRANSITION_A, phase: 'ready' });
      await act(async () => {
        await runtime.downloadModel(TRANSITION_B);
        mockNative.completeDownload(TRANSITION_B);
        await flush();
      });
      await settle(2_000);
      expect(runtime.downloads.snapshot(TRANSITION_B).phase).toBe('ready');
      const api = store.get(apiClientAtom);
      if (!api) {
        throw new Error('Expected the existing local client.');
      }
      let acknowledge: (() => void) | undefined;
      if (heldAck) {
        const original = api.setThreadConfigOption.bind(api);
        const gate = new Promise<void>((resolve) => {
          acknowledge = resolve;
        });
        jest.spyOn(api, 'setThreadConfigOption').mockImplementationOnce(async (...args) => {
          const updated = await original(...args);
          await gate;
          return updated;
        });
      }
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await act(async () => {
        modelPickerOption(root, TRANSITION_B).onPress();
        await flush();
      });
      await settle();
      expect(runtime.threads.get(existing.id).modelId).toBe(TRANSITION_B);
      expect(runtime.preferences().modelId).toBe(TRANSITION_B);
      expect(runtime.models.snapshot()).toMatchObject({ modelId: TRANSITION_A, phase: 'ready' });
      expect(mockLlama.loads.map(({ modelId }) => modelId)).toEqual([TRANSITION_A]);
      mockLlama.holdLoads = true;
      mockLlama.holdCompletions = true;
      mockLlama.reply({ content: 'New-model reply.' });
      await submit(root, 'Continue this same conversation.');
      if (heldAck) {
        expect(mockLlama.loads.map(({ modelId }) => modelId)).toEqual([TRANSITION_A]);
        expect(composerText(root)).toBe('Continue this same conversation.');
        expect(hasText(root, 'Wait for the model selection to finish saving')).toBe(true);
        await drive(() => acknowledge?.());
        await press(root, 'Send message');
      }
      expect(mockLlama.loads.at(-1)?.modelId).toBe(TRANSITION_B);
      expect(runtime.threads.get(existing.id).messages).toEqual(history);
      expect(composerText(root)).toBe('');
      expect(labeled(root, 'Stop agent')).toBeDefined();
      await drive(() => mockLlama.finishLoad());
      expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
      expect(composerText(root)).toBe('');
      await drive(() => mockLlama.finishCompletion());
      acknowledge?.();
      await settle();
      const completed = runtime.threads.get(existing.id);
      expect(completed.status).toBe('complete');
      expect(completed.messages.slice(0, history.length)).toEqual(history);
      expect(runtime.threads.list()).toHaveLength(1);
      expect(mockLlama.ownershipHighWater).toBe(1);
      expect(mockLlama.resourceEvents).toEqual([
        { type: 'initializing', modelId: TRANSITION_A },
        { type: 'ready', modelId: TRANSITION_A },
        { type: 'releasing', modelId: TRANSITION_A },
        { type: 'released', modelId: TRANSITION_A },
        { type: 'initializing', modelId: TRANSITION_B },
        { type: 'ready', modelId: TRANSITION_B },
      ]);
      expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      expect(labeled(root, 'Retry turn')).toBeUndefined();
      expect(store.get(activeChatAtom)?.id).toBe(existing.id);
      act(() => tree.unmount());
    },
  );

  it('refreshes an already open model picker when a background download becomes verified', async () => {
    const { tree, root, runtime, thread, store } = await renderTransitionChat({
      downloaded: [TRANSITION_A],
    });
    const api = store.get(apiClientAtom);
    if (!api) {
      throw new Error('Expected the mounted model catalog client.');
    }
    const catalogReads = jest.spyOn(api, 'listModelOptions');
    await act(async () => {
      await runtime.downloadModel(TRANSITION_B);
      await flush();
    });
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    expect(() => modelPickerOption(root, TRANSITION_B)).toThrow('Missing model picker option');
    await act(async () => {
      await runtime.downloads.pause(TRANSITION_B);
    });
    expect(runtime.downloads.snapshot(TRANSITION_B).phase).toBe('paused');
    expect(() => modelPickerOption(root, TRANSITION_B)).toThrow('Missing model picker option');
    await act(async () => {
      await runtime.downloadModel(TRANSITION_B);
    });
    let finishVerification: (() => void) | undefined;
    const verification = new Promise<void>((resolve) => {
      finishVerification = resolve;
    });
    const finalize = runtime.native.finalizeModelDownload.bind(runtime.native);
    jest.spyOn(runtime.native, 'finalizeModelDownload').mockImplementationOnce(async (...args) => {
      await verification;
      return finalize(...args);
    });
    await drive(() => mockNative.completeDownload(TRANSITION_B));
    await settle(2_000);
    expect(runtime.downloads.snapshot(TRANSITION_B).phase).toBe('verifying');
    expect(() => modelPickerOption(root, TRANSITION_B)).toThrow('Missing model picker option');
    await drive(() => finishVerification?.());
    await settle(1_000);
    expect(runtime.downloads.snapshot(TRANSITION_B).phase).toBe('ready');
    expect(modelPickerOption(root, TRANSITION_B)).toBeDefined();
    expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
    expect(runtime.preferences().modelId).toBe(TRANSITION_A);
    expect(mockLlama.loads).toHaveLength(1);
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    await submit(root, 'Use the newly verified background download.');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.threads.get(thread.id).status).toBe('complete');
    const readsAfterClosing = catalogReads.mock.calls.length;
    await settle(3_000);
    expect(catalogReads).toHaveBeenCalledTimes(readsAfterClosing);
    act(() => tree.unmount());
  });

  it('immediately carries an existing-chat model choice into New chat while keeping per-chat choices independent', async () => {
    const { tree, root, runtime, thread, history, store } = await renderTransitionChat();
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    expect(runtime.preferences().modelId).toBe(TRANSITION_B);
    act(() => store.set(startNewChatAtom));
    await settle();
    expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
    expect(runtime.models.snapshot()).toMatchObject({ modelId: TRANSITION_A, phase: 'ready' });
    await press(root, 'Model, Qwen3.5 0.8B Q4_0');
    await drive(() => modelPickerOption(root, TRANSITION_A).onPress());
    expect(runtime.preferences().modelId).toBe(TRANSITION_A);
    expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_B);
    await submit(root, 'Create an A sibling without changing T.');
    const sibling = runtime.threads.list().find((entry) => entry.id !== thread.id);
    expect(sibling?.modelId).toBe(TRANSITION_A);
    act(() => store.set(selectChatAtom, thread.id));
    await settle();
    expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
    await submit(root, 'Continue T on B without changing the new-chat A default.');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.threads.get(thread.id).messages.slice(0, history.length)).toEqual(history);
    expect(runtime.preferences().modelId).toBe(TRANSITION_A);
    expect(runtime.threads.list().find((entry) => entry.id === sibling?.id)?.modelId).toBe(
      TRANSITION_A,
    );
    expect(mockLlama.ownershipHighWater).toBe(1);
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    act(() => tree.unmount());
  });

  it('preserves the latest queued choice when Send races an older configuration acknowledgment', async () => {
    const { tree, root, runtime, store, thread } = await renderTransitionChat();
    const api = store.get(apiClientAtom);
    if (!api) {
      throw new Error('Expected the local configuration client.');
    }
    const original = api.setThreadConfigOption.bind(api);
    let acknowledge: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const save = jest
      .spyOn(api, 'setThreadConfigOption')
      .mockImplementationOnce(async (...args) => {
        const updated = await original(...args);
        await gate;
        return updated;
      });
    try {
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      await press(root, 'Model, Qwen3.5 0.8B Q4_0');
      await drive(() => modelPickerOption(root, TRANSITION_A).onPress());
      expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_B);
      expect(save).toHaveBeenCalledTimes(1);
      mockLlama.holdCompletions = true;
      const executions = mockLlama.executions.length;
      await submit(root, 'The latest accepted A selection should execute.');
      await drive(() => acknowledge?.());
      if (mockLlama.executions.length === executions) {
        expect(composerText(root)).toBe('The latest accepted A selection should execute.');
        expect(hasText(root, 'Wait for the model selection to finish saving')).toBe(true);
        await press(root, 'Send message');
      }
      await drive(() => mockLlama.finishCompletion());
      expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
      expect(runtime.preferences().modelId).toBe(TRANSITION_A);
      expect(save).toHaveBeenCalledTimes(2);
      expect(mockLlama.loads).toHaveLength(1);
      expect(mockLlama.executions.at(-1)).toBe(TRANSITION_A);
      expect(labeled(root, 'Model, Bonsai 2 2B Q2_0')).toBeDefined();
      expect(runtime.threads.get(thread.id).status).toBe('complete');
    } finally {
      acknowledge?.();
      act(() => tree.unmount());
    }
  });

  it('reconciles the actual saved choice when its configuration acknowledgment fails after commit', async () => {
    const { tree, root, runtime, thread, history } = await renderTransitionChat();
    const choose = runtime.chooseModel.bind(runtime);
    jest.spyOn(runtime, 'chooseModel').mockImplementationOnce(async (...args) => {
      await choose(...args);
      throw new Error('Model acknowledgment failed after saving.');
    });
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_B);
    expect(runtime.preferences().modelId).toBe(TRANSITION_B);
    expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
    expect(runtime.threads.get(thread.id).messages).toEqual(history);
    expect(hasText(root, 'Model acknowledgment failed after saving.')).toBe(true);
    await submit(root, 'Use the actually saved B choice.');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.threads.get(thread.id).status).toBe('complete');
    expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_B);
    expect(runtime.preferences().modelId).toBe(TRANSITION_B);
    act(() => tree.unmount());
  });

  it('keeps an uncertain choice blocked when read-back fails until the user explicitly selects again', async () => {
    const { tree, root, runtime, thread, history, store } = await renderTransitionChat();
    const api = store.get(apiClientAtom);
    if (!api) {
      throw new Error('Expected the local configuration client.');
    }
    const choose = runtime.chooseModel.bind(runtime);
    const choices = jest.spyOn(runtime, 'chooseModel').mockImplementationOnce(async (...args) => {
      await choose(...args);
      throw new Error('Selection response uncertain.');
    });
    jest.spyOn(api, 'getChat').mockRejectedValueOnce(new Error('Read-back unavailable.'));
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    expect(hasText(root, 'Could not confirm the saved configuration: Read-back unavailable.')).toBe(
      true,
    );
    const executions = mockLlama.executions.length;
    await submit(root, 'Preserve this unconfirmed-choice request.');
    expect(mockLlama.executions).toHaveLength(executions);
    expect(runtime.threads.get(thread.id).messages).toEqual(history);
    expect(composerText(root)).toBe('Preserve this unconfirmed-choice request.');
    expect(hasText(root, 'Select the option again before sending.')).toBe(true);
    expect(choices).toHaveBeenCalledTimes(1);
    await press(root, 'Model, Qwen3.5 0.8B Q4_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    expect(choices).toHaveBeenCalledTimes(2);
    await press(root, 'Send message');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.threads.get(thread.id).status).toBe('complete');
    expect(composerText(root)).toBe('');
    act(() => tree.unmount());
  });

  it.each(['new-chat', 'existing-chat', 'lost-ack', 'successful-choice'])(
    'keeps disk, UI and crash-restored defaults consistent when a workspace save overlaps %s selection',
    async (variant) => {
      const { tree, root, runtime, thread, store } = await renderTransitionChat({
        workspaces: [
          { id: 'ws-one', name: 'Demo', isRepository: true },
          { id: 'ws-two', name: 'Scratch', isRepository: false },
        ],
      });
      const existing = variant === 'existing-chat';
      if (!existing) {
        act(() => store.set(startNewChatAtom));
        await settle();
      }
      const original = runtime.native.writeRuntimeDocument.bind(runtime.native);
      let held = false;
      let resolveWrite: (() => void) | undefined;
      let rejectWrite: ((error: Error) => void) | undefined;
      jest
        .spyOn(runtime.native, 'writeRuntimeDocument')
        .mockImplementation(async (name, contents) => {
          if (name === 'preferences.json' && !held) {
            held = true;
            if (variant === 'lost-ack') {
              await original(name, contents);
            }
            await new Promise<void>((resolve, reject) => {
              resolveWrite = resolve;
              rejectWrite = reject;
            });
            if (variant !== 'lost-ack') {
              await original(name, contents);
            }
            return;
          }
          await original(name, contents);
        });
      let selectingWorkspace: Promise<boolean> | undefined;
      let snapshot: Record<string, string>;
      try {
        await press(root, 'Model, Bonsai 2 2B Q2_0');
        await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
        expect(held).toBe(true);
        if (existing) {
          act(() => store.set(startNewChatAtom));
          await settle();
        }
        await act(async () => {
          selectingWorkspace = store.set(selectManagedWorkspaceAtom, '/On this iPhone/Scratch');
          await flush();
        });
        await settle();
        if (variant === 'successful-choice') {
          await drive(() => resolveWrite?.());
        } else {
          await drive(() => rejectWrite?.(new Error('Overlapping model choice failed.')));
        }
        expect(await selectingWorkspace).toBe(true);
        await settle();
        const expected = variant === 'successful-choice' ? TRANSITION_B : TRANSITION_A;
        expect(runtime.preferences()).toMatchObject({ modelId: expected, workspaceId: 'ws-two' });
        snapshot = Object.fromEntries(mockNative.documents);
        expect(JSON.parse(snapshot['preferences.json']!)).toMatchObject({
          modelId: expected,
          workspaceId: 'ws-two',
        });
        expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
        expect(
          labeled(
            root,
            `Model, ${expected === TRANSITION_A ? 'Bonsai 2 2B Q2_0' : 'Qwen3.5 0.8B Q4_0'}`,
          ),
        ).toBeDefined();
        expect(labeled(root, 'Retry saving')).toBeUndefined();
        expect(drawerStatus(root)).not.toBe('1 issue needs attention');
        expect(labeled(root, 'Stop agent')).toBeUndefined();
      } finally {
        rejectWrite?.(new Error('Fixture cleanup.'));
        act(() => tree.unmount());
      }
      const restarted = await renderShell({
        downloaded: [TRANSITION_A, TRANSITION_B],
        workspaces: [
          { id: 'ws-one', name: 'Demo', isRepository: true },
          { id: 'ws-two', name: 'Scratch', isRepository: false },
        ],
        documents: snapshot!,
      });
      const expected = variant === 'successful-choice' ? TRANSITION_B : TRANSITION_A;
      expect(restarted.runtime.preferences()).toMatchObject({
        modelId: expected,
        workspaceId: 'ws-two',
      });
      expect(restarted.runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
      expect(
        labeled(
          restarted.root,
          `Model, ${expected === TRANSITION_A ? 'Bonsai 2 2B Q2_0' : 'Qwen3.5 0.8B Q4_0'}`,
        ),
      ).toBeDefined();
      act(() => restarted.tree.unmount());
    },
  );

  it.each(['write-failed', 'write-before-reject', 'rollback-failed'])(
    'keeps restored chat models honest after a %s thread acknowledgment',
    async (variant) => {
      const { tree, root, runtime, thread, history } = await renderTransitionChat();
      await act(async () => {
        await runtime.flush();
      });
      await settle();
      const write = runtime.native.writeRuntimeDocument.bind(runtime.native);
      let faulted = false;
      let failRecovery = variant === 'rollback-failed';
      jest
        .spyOn(runtime.native, 'writeRuntimeDocument')
        .mockImplementation(async (name, contents) => {
          if (name.startsWith('thread')) {
            const value = toRecord(JSON.parse(contents));
            const set = toRecord(value?.['set']);
            if (
              !faulted &&
              (value?.['modelId'] === TRANSITION_B || set?.['modelId'] === TRANSITION_B)
            ) {
              faulted = true;
              if (variant !== 'write-failed') {
                await write(name, contents);
              }
              throw new Error('Thread model acknowledgment failed.');
            }
            if (faulted && failRecovery) {
              throw new Error('Thread rollback storage unavailable.');
            }
          }
          await write(name, contents);
        });
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      expect(faulted).toBe(true);
      expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
      expect(runtime.preferences().modelId).toBe(TRANSITION_A);
      expect(labeled(root, 'Model, Bonsai 2 2B Q2_0')).toBeDefined();
      expect(runtime.threads.get(thread.id).messages).toEqual(history);
      if (variant === 'rollback-failed') {
        expect(drawerStatus(root)).toBe('1 issue needs attention');
        expect(labeled(root, 'Retry saving')).toBeDefined();
        failRecovery = false;
        await press(root, 'Retry saving');
      }
      expect(drawerStatus(root)).not.toBe('1 issue needs attention');
      expect(labeled(root, 'Retry saving')).toBeUndefined();
      await changeAppState('background');
      const snapshot = Object.fromEntries(mockNative.documents);
      act(() => tree.unmount());
      const restarted = await renderShell({
        downloaded: [TRANSITION_A, TRANSITION_B],
        documents: snapshot,
        files: { 'ws-one:seed.txt': 'alpha\n' },
      });
      expect(restarted.runtime.threads.get(thread.id)).toMatchObject({
        modelId: TRANSITION_A,
        workspaceId: thread.workspaceId,
        messages: history,
      });
      act(() => restarted.store.set(selectChatAtom, thread.id));
      await settle();
      expect(labeled(restarted.root, 'Model, Bonsai 2 2B Q2_0')).toBeDefined();
      await submit(restarted.root, 'Confirm the restored A choice.');
      expect(mockLlama.executions.at(-1)).toBe(TRANSITION_A);
      expect(restarted.runtime.threads.get(thread.id).status).toBe('complete');
      expect(labeled(restarted.root, 'Stop agent')).toBeUndefined();
      act(() => restarted.tree.unmount());
    },
  );

  it('rejects Send while a model choice is not durable and restores its draft after the choice fails', async () => {
    const { tree, root, runtime } = await renderShell({
      downloaded: [TRANSITION_A, TRANSITION_B],
      documents: {
        'preferences.json': JSON.stringify({
          ...emptyLocalPreferences(),
          modelId: TRANSITION_A,
          workspaceId: 'ws-one',
        }),
      },
    });
    await submit(root, 'Baseline A.');
    const [thread] = runtime.threads.list();
    if (!thread) {
      throw new Error('Expected the original conversation.');
    }
    const history = structuredClone(thread.messages);
    const original = runtime.native.writeRuntimeDocument.bind(runtime.native);
    let rejectChoice: ((error: Error) => void) | undefined;
    let held = false;
    jest
      .spyOn(runtime.native, 'writeRuntimeDocument')
      .mockImplementation(async (name, contents) => {
        if (name === 'preferences.json' && !held) {
          held = true;
          await new Promise<void>((_resolve, reject) => {
            rejectChoice = reject;
          });
        }
        await original(name, contents);
      });
    try {
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      expect(held).toBe(true);
      await submit(root, 'Keep this draft if selection fails.');
      expect(mockLlama.executions).toEqual([TRANSITION_A]);
      expect(runtime.threads.get(thread.id).messages).toEqual(history);
      rejectChoice?.(new Error('Default selection could not be saved.'));
      await settle();
      expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
      expect(runtime.preferences().modelId).toBe(TRANSITION_A);
      expect(composerText(root)).toBe('Keep this draft if selection fails.');
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      expect(labeled(root, 'Retry turn')).toBeUndefined();
      expect(labeled(root, 'Model, Bonsai 2 2B Q2_0')).toBeDefined();
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      await press(root, 'Send message');
      expect(mockLlama.executions).toEqual([TRANSITION_A, TRANSITION_B]);
      expect(
        runtime.threads
          .get(thread.id)
          .messages.filter(
            (message) =>
              message.role === 'user' && message.content === 'Keep this draft if selection fails.',
          ),
      ).toHaveLength(1);
      expect(runtime.threads.get(thread.id).status).toBe('complete');
      expect(composerText(root)).toBe('');
    } finally {
      rejectChoice?.(new Error('Fixture cleanup.'));
      act(() => tree.unmount());
    }
  });

  it('stops a B preparation, preserves its draft, and releases a late B before recovering on A', async () => {
    const { tree, root, runtime, thread, history } = await renderTransitionChat();
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    mockLlama.holdLoads = true;
    await submit(root, 'Preserve this unadmitted request.');
    expect(mockLlama.loadPending).toBe(true);
    await press(root, 'Stop agent');
    expect(runtime.loop.snapshot().phase).toBe('idle');
    expect(runtime.threads.get(thread.id).messages).toEqual(history);
    expect(composerText(root)).toBe('Preserve this unadmitted request.');
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(labeled(root, 'Retry turn')).toBeUndefined();
    await press(root, 'Model, Qwen3.5 0.8B Q4_0');
    await drive(() => modelPickerOption(root, TRANSITION_A).onPress());
    mockLlama.holdCompletions = true;
    await submit(root, 'A recovery request.');
    expect(mockLlama.loads.map((load) => load.modelId)).toEqual([TRANSITION_A, TRANSITION_B]);
    mockLlama.holdLoads = false;
    await drive(() => mockLlama.loadProgress(91));
    await drive(() => mockLlama.finishLoad());
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_A);
    expect(mockLlama.ownershipHighWater).toBe(1);
    const releasedB = mockLlama.resourceEvents.findIndex(
      (event) => event.type === 'released' && event.modelId === TRANSITION_B,
    );
    expect(releasedB).toBeGreaterThan(0);
    expect(mockLlama.resourceEvents.slice(releasedB + 1)).toEqual([
      { type: 'initializing', modelId: TRANSITION_A },
      { type: 'ready', modelId: TRANSITION_A },
    ]);
    await drive(() => mockLlama.finishCompletion());
    expect({
      status: runtime.threads.get(thread.id).status,
      error: runtime.threads.get(thread.id).lastError,
      stops: mockLlama.stops,
      loop: runtime.loop.snapshot(),
    }).toMatchObject({ status: 'complete', error: null, stops: 0 });
    expect(
      runtime.threads
        .get(thread.id)
        .messages.filter((message) => message.content === 'Preserve this unadmitted request.'),
    ).toHaveLength(0);
    expect(runtime.threads.get(thread.id).messages.slice(0, history.length)).toEqual(history);
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(composerText(root)).toBe('');
    act(() => tree.unmount());
  });

  it('rejects switching during generation and stopping, then fences late A tokens from B', async () => {
    const { tree, root, runtime, thread } = await renderTransitionChat();
    mockLlama.holdCompletions = true;
    await submit(root, 'A running request.');
    const lateA = mockLlama.tokenCallbacks.at(-1);
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
    expect(hasText(root, 'Stop this conversation before changing its model.')).toBe(true);
    expect(mockLlama.loads).toHaveLength(1);
    mockLlama.holdStops = true;
    await press(root, 'Stop agent');
    expect(labeled(root, 'Stopping agent')).toBeDefined();
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
    await drive(() => mockLlama.finishStop());
    expect(runtime.threads.get(thread.id).status).toBe('interrupted');
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(labeled(root, 'Stopping agent')).toBeUndefined();
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    mockLlama.holdStops = false;
    await submit(root, 'B running request.');
    await drive(() => lateA?.('STALE A OUTPUT'));
    await drive(() => mockLlama.finishCompletion());
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.threads.get(thread.id).status).toBe('complete');
    expect(transcript(root).join(' ')).not.toContain('STALE A OUTPUT');
    expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
    expect(mockLlama.ownershipHighWater).toBe(1);
    act(() => tree.unmount());
  });

  it('rejects removed B weights before allocation and recovers after verified reinstallation without changing history', async () => {
    const { tree, root, runtime, thread, history } = await renderTransitionChat();
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    mockNative.installed.delete(TRANSITION_B);
    await submit(root, 'Keep this request while B is unavailable.');
    expect(mockLlama.loads.map((load) => load.modelId)).toEqual([TRANSITION_A]);
    expect(runtime.threads.get(thread.id).messages).toEqual(history);
    expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_B);
    expect(runtime.preferences().modelId).toBe(TRANSITION_B);
    expect(composerText(root)).toBe('Keep this request while B is unavailable.');
    expect(hasText(root, 'Download and verify this catalog model before loading it.')).toBe(true);
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(mockLlama.resident.size).toBe(0);
    mockNative.installed.add(TRANSITION_B);
    await press(root, 'Send message');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.threads.get(thread.id).status).toBe('complete');
    expect(runtime.threads.get(thread.id).messages.slice(0, history.length)).toEqual(history);
    expect(mockLlama.ownershipHighWater).toBe(1);
    expect(composerText(root)).toBe('');
    act(() => tree.unmount());
  });

  it.each(['memory', 'initialize', 'release'])(
    'recovers a failed %s during lazy A-to-B replacement without admitting or losing the request',
    async (failure) => {
      const { tree, root, runtime, thread, history } = await renderTransitionChat();
      const executions = mockLlama.executions.length;
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      if (failure === 'memory') {
        mockNative.memory.availableBytes = 64 * 1024 ** 2;
      }
      mockLlama.holdLoads = failure === 'initialize';
      mockLlama.holdReleases = failure === 'release';
      await submit(root, 'Keep my request after replacement failure.');
      if (failure === 'initialize') {
        await drive(() => mockLlama.failLoad('B initialization failed.'));
      } else if (failure === 'release') {
        expect(mockLlama.loads).toHaveLength(1);
        await drive(() => mockLlama.failRelease('A release failed.'));
      }
      expect(mockLlama.executions).toHaveLength(executions);
      expect(runtime.loop.snapshot().phase).toBe('idle');
      expect(runtime.threads.get(thread.id).messages).toEqual(history);
      expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_B);
      expect(runtime.preferences().modelId).toBe(TRANSITION_B);
      expect(composerText(root)).toBe('Keep my request after replacement failure.');
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      expect(labeled(root, 'Retry turn')).toBeUndefined();
      expect([...mockLlama.resident.values()].map((model) => model.modelId)).toEqual(
        failure === 'release' ? [TRANSITION_A] : [],
      );
      mockNative.memory.availableBytes = 6 * 1024 ** 3;
      mockLlama.holdLoads = false;
      mockLlama.holdReleases = false;
      await press(root, 'Send message');
      expect(mockLlama.executions).toHaveLength(executions + 1);
      expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
      expect(runtime.threads.get(thread.id).status).toBe('complete');
      expect(
        runtime.threads
          .get(thread.id)
          .messages.filter(
            (message) =>
              message.role === 'user' &&
              message.content === 'Keep my request after replacement failure.',
          ),
      ).toHaveLength(1);
      expect(mockLlama.ownershipHighWater).toBe(1);
      expect(composerText(root)).toBe('');
      act(() => tree.unmount());
    },
  );

  it('admits B using fresh physical-shaped memory measured only after A actually releases', async () => {
    const { tree, root, runtime } = await renderTransitionChat();
    const required = modelMemoryBytes(localModelDefinition(TRANSITION_B));
    mockNative.memory.availableBytes = required + 32 * 1024 ** 2;
    expect(runtime.native.getMemoryInfo().availableBytes).toBeLessThan(required);
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    await submit(root, 'Switch with only enough memory after release.');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.models.snapshot()).toMatchObject({ modelId: TRANSITION_B, phase: 'ready' });
    expect(mockLlama.ownershipHighWater).toBe(1);
    act(() => tree.unmount());
  });

  it.each(['stopped', 'failed'])(
    'retries a %s tool-rich A turn on B without repeating completed file or Git mutations',
    async (outcome) => {
      const { tree, root, runtime, thread, store } = await renderTransitionChat();
      const commit = runtime.native.commitWorkspaceGit.bind(runtime.native);
      jest.spyOn(runtime.native, 'commitWorkspaceGit').mockImplementation(async (...args) => {
        const hash = await commit(...args);
        mockLlama.holdCompletions = true;
        return hash;
      });
      mockLlama.reply(
        {
          toolCalls: [
            { name: 'write_file', arguments: { path: 'result.txt', content: 'COMMITTED\n' } },
            { name: 'git_stage', arguments: { path: 'result.txt' } },
            { name: 'git_commit', arguments: { message: 'Transition fixture' } },
          ],
        },
        outcome === 'failed'
          ? { fail: 'Final answer failed.' }
          : { content: 'Committed the fixture.' },
      );
      await submit(root, 'Create and commit result.txt.');
      expect(mockLlama.completionPending).toBe(true);
      expect(runtime.native.commitWorkspaceGit).toHaveBeenCalledTimes(1);
      if (outcome === 'stopped') {
        await press(root, 'Stop agent');
      } else {
        await drive(() => mockLlama.finishCompletion());
      }
      expect(runtime.threads.get(thread.id).status).toBe(
        outcome === 'stopped' ? 'interrupted' : 'failed',
      );
      const completedTools = runtime.threads
        .get(thread.id)
        .messages.filter((message) => message.tool);
      expect(completedTools.filter((message) => message.tool?.name === 'git_commit')).toHaveLength(
        1,
      );
      const mutations = mockNative.calls.filter((call) =>
        /^(writeWorkspaceFile|stageWorkspaceGit|commitWorkspaceGit):/u.test(call),
      );
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      mockLlama.holdCompletions = false;
      if (outcome === 'stopped') {
        expect(labeled(root, 'Retry turn')).toBeUndefined();
        const ws = store.get(wsClientAtom);
        if (!ws) {
          throw new Error('Expected the local transport for interrupted-turn continuation.');
        }
        await act(async () => {
          await ws.request(TURN_RETRY_METHOD, { threadId: thread.id });
          await flush();
        });
        await settle();
      } else {
        await press(root, 'Retry turn');
      }
      expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
      expect(runtime.threads.get(thread.id).status).toBe('complete');
      expect(runtime.threads.get(thread.id).messages.filter((message) => message.tool)).toEqual(
        completedTools,
      );
      expect(
        runtime.threads
          .get(thread.id)
          .messages.filter(
            (message) =>
              message.role === 'user' && message.content === 'Create and commit result.txt.',
          ),
      ).toHaveLength(1);
      expect(
        mockNative.calls.filter((call) =>
          /^(writeWorkspaceFile|stageWorkspaceGit|commitWorkspaceGit):/u.test(call),
        ),
      ).toEqual(mutations);
      expect(mockNative.files.get('ws-one:result.txt')).toBe('COMMITTED\n');
      expect(labeled(root, 'Retry turn')).toBeUndefined();
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      expect(composerText(root)).toBe('');
      act(() => tree.unmount());
    },
  );

  it.each([false, true])(
    'fences a model switch and stale approval around push Stop (allowed %s)',
    async (allowed) => {
      const { tree, root, runtime, thread } = await renderTransitionChat();
      let acknowledgePush: (() => void) | undefined;
      const push = runtime.native.pushWorkspaceGit.bind(runtime.native);
      jest.spyOn(runtime.native, 'pushWorkspaceGit').mockImplementation(async (...args) => {
        await push(...args);
        await new Promise<void>((resolve) => {
          acknowledgePush = resolve;
        });
      });
      mockLlama.reply(
        { toolCalls: [{ name: 'git_push', arguments: {} }] },
        { content: 'Push completed.' },
      );
      await submit(root, 'Push the committed branch.');
      const allow = labeled(root, 'Allow');
      if (!allow) {
        throw new Error('Expected the actual Git push approval.');
      }
      const staleAllow = allow.props['onPress'] as () => void;
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
      if (allowed) {
        await press(root, 'Allow');
        expect(runtime.native.pushWorkspaceGit).toHaveBeenCalledTimes(1);
      }
      await press(root, 'Stop agent');
      if (allowed) {
        await press(root, 'Model, Bonsai 2 2B Q2_0');
        await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
        expect(runtime.threads.get(thread.id).modelId).toBe(TRANSITION_A);
        await drive(() => acknowledgePush?.());
      } else {
        await drive(() => staleAllow());
      }
      expect(runtime.native.pushWorkspaceGit).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(runtime.threads.get(thread.id).status).toBe('interrupted');
      if (allowed) {
        expect(
          runtime.threads
            .get(thread.id)
            .messages.find((message) => message.tool?.name === 'git_push')?.tool?.status,
        ).toBe('completed');
      }
      expect(labeled(root, 'Allow')).toBeUndefined();
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      await submit(root, 'Continue on B without pushing again.');
      expect(runtime.threads.get(thread.id).status).toBe('complete');
      expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
      expect(runtime.native.pushWorkspaceGit).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(mockLlama.ownershipHighWater).toBe(1);
      act(() => tree.unmount());
    },
  );

  it('does not deliver an old model-selection failure into a reactivated profile screen', async () => {
    const { tree, root, runtime, store } = await renderTransitionChat();
    const api = store.get(apiClientAtom);
    if (!api) {
      throw new Error('Expected the original configuration client.');
    }
    const original = api.setThreadConfigOption.bind(api);
    let rejectAcknowledgment: ((error: Error) => void) | undefined;
    const gate = new Promise<void>((_resolve, reject) => {
      rejectAcknowledgment = reject;
    });
    jest.spyOn(api, 'setThreadConfigOption').mockImplementationOnce(async (...args) => {
      const updated = await original(...args);
      await gate;
      return updated;
    });
    try {
      await press(root, 'Model, Bonsai 2 2B Q2_0');
      await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
      act(() => setActiveProfile(store, 'bridge-1'));
      await settle();
      expect(store.get(localRuntimeAtom)).toBeNull();
      act(() => setActiveProfile(store, LOCAL_PROFILE_ID));
      await settle();
      expect(store.get(localRuntimeAtom)).not.toBe(runtime);
      expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
      await drive(() =>
        rejectAcknowledgment?.(new Error('Old profile model acknowledgment failed.')),
      );
      expect(hasText(root, 'Old profile model acknowledgment failed.')).toBe(false);
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
    } finally {
      rejectAcknowledgment?.(new Error('Fixture cleanup.'));
      act(() => tree.unmount());
    }
  });

  it('restores a confirmed B choice and draft through an actual profile disposal without replay', async () => {
    const storedFiles = new Map<string, string>();
    fileSystemMock.read.mockImplementation(async (path) => {
      const contents = storedFiles.get(path);
      if (contents === undefined) {
        throw new Error('Missing fixture profile document.');
      }
      return contents;
    });
    fileSystemMock.write.mockImplementation(async (path, contents) => {
      storedFiles.set(path, contents);
    });
    fileSystemMock.info.mockImplementation(async (path) => ({
      exists: storedFiles.has(path),
      size: storedFiles.get(path)?.length ?? 0,
    }));
    fileSystemMock.exists.mockImplementation((path) => storedFiles.has(path));
    const { tree, root, runtime, thread, history, store } = await renderTransitionChat();
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    await act(async () => {
      const input = labeled(root, 'Message');
      if (!input) {
        throw new Error('Expected the composer before profile disposal.');
      }
      (input.props['onChangeText'] as (value: string) => void)('Persist this B draft.');
      await flush();
    });
    await settle();
    expect(composerText(root)).toBe('Persist this B draft.');
    const executions = [...mockLlama.executions];
    act(() => setActiveProfile(store, 'bridge-1'));
    await settle();
    expect(store.get(localRuntimeAtom)).toBeNull();
    expect(mockLlama.resident.size).toBe(0);
    act(() => setActiveProfile(store, LOCAL_PROFILE_ID));
    await settle();
    const restored = store.get(localRuntimeAtom);
    if (!restored) {
      throw new Error('Expected a new local runtime after profile activation.');
    }
    expect(restored).not.toBe(runtime);
    expect(restored.threads.get(thread.id)).toMatchObject({
      modelId: TRANSITION_B,
      workspaceId: thread.workspaceId,
      messages: history,
    });
    expect(restored.preferences().modelId).toBe(TRANSITION_B);
    expect(mockLlama.executions).toEqual(executions);
    act(() => store.set(selectChatAtom, thread.id));
    await settle();
    expect(store.get(activeChatAtom)?.id).toBe(thread.id);
    expect(composerText(root)).toBe('Persist this B draft.');
    expect(labeled(root, 'Model, Qwen3.5 0.8B Q4_0')).toBeDefined();
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    await press(root, 'Send message');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(restored.threads.get(thread.id).status).toBe('complete');
    expect(mockLlama.ownershipHighWater).toBe(1);
    act(() => tree.unmount());
  });

  it('compacts A history for a smaller B context without rewriting durable history or tool pairs', async () => {
    const { tree, root, runtime, thread } = await renderTransitionChat();
    await submit(root, `An older large note: ${'x'.repeat(70_000)}`);
    const history = structuredClone(runtime.threads.get(thread.id).messages);
    mockNative.memory.availableBytes = modelMemoryBytes(localModelDefinition(TRANSITION_B));
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    mockLlama.reply(
      { toolCalls: [{ name: 'read_file', arguments: { path: 'seed.txt' } }] },
      { content: 'B read alpha.' },
    );
    await submit(root, 'Read seed.txt using the smaller B context.');
    expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
    expect(runtime.threads.get(thread.id).status).toBe('complete');
    expect(runtime.threads.get(thread.id).messages.slice(0, history.length)).toEqual(history);
    expect(runtime.threads.get(thread.id).messages.at(-1)?.content).toBe('B read alpha.');
    expect(runtime.models.snapshot().contextTokens).toBe(
      localModelDefinition(TRANSITION_B).contextTokens,
    );
    expect(mockLlama.promptTokens.at(-1)).toBeLessThan(
      localModelDefinition(TRANSITION_B).contextTokens,
    );
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(composerText(root)).toBe('');
    act(() => tree.unmount());
  });

  it('excludes a lazy B Send from manual Files Save in both operation orders without replaying the save', async () => {
    const { tree, root, runtime, thread, history, store } = await renderTransitionChat();
    const ws = store.get(wsClientAtom);
    const cwd = store.get(activeChatAtom)?.cwd;
    if (!ws || !cwd) {
      throw new Error('Expected the real Files transport and selected workspace.');
    }
    await press(root, 'Model, Bonsai 2 2B Q2_0');
    await drive(() => modelPickerOption(root, TRANSITION_B).onPress());
    const file = await ws.request<{ revision: string }>(WORKSPACE_HOST_METHODS.filesRead, {
      cwd,
      path: 'seed.txt',
    });
    let acknowledgeSave: (() => void) | undefined;
    const save = runtime.native.writeWorkspaceFile.bind(runtime.native);
    const writes = jest
      .spyOn(runtime.native, 'writeWorkspaceFile')
      .mockImplementationOnce(async (...args) => {
        const revision = await save(...args);
        await new Promise<void>((resolve) => {
          acknowledgeSave = resolve;
        });
        return revision;
      });
    const executions = mockLlama.executions.length;
    let saving: Promise<unknown> | undefined;
    try {
      await drive(() => {
        saving = ws.request(WORKSPACE_HOST_METHODS.filesWrite, {
          cwd,
          path: 'seed.txt',
          content: 'MANUAL\n',
          revision: file.revision,
        });
      });
      expect(mockNative.files.get('ws-one:seed.txt')).toBe('MANUAL\n');
      await submit(root, 'Send on B once manual Save settles.');
      expect(mockLlama.executions).toHaveLength(executions);
      expect(mockLlama.loads).toHaveLength(1);
      expect(runtime.threads.get(thread.id).messages).toEqual(history);
      expect(composerText(root)).toBe('Send on B once manual Save settles.');
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      await drive(() => acknowledgeSave?.());
      await saving;
      await press(root, 'Send message');
      expect(mockLlama.executions.at(-1)).toBe(TRANSITION_B);
      expect(runtime.threads.get(thread.id).status).toBe('complete');
      expect(writes).toHaveBeenCalledTimes(1);
      mockLlama.holdCompletions = true;
      await submit(root, 'Keep B generation active.');
      await expect(
        ws.request(WORKSPACE_HOST_METHODS.filesWrite, {
          cwd,
          path: 'seed.txt',
          content: 'MUST NOT WRITE\n',
          revision: 'rev-7',
        }),
      ).rejects.toThrow(/Stop|running|Wait/u);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(mockNative.files.get('ws-one:seed.txt')).toBe('MANUAL\n');
      await drive(() => mockLlama.finishCompletion());
      expect(runtime.threads.get(thread.id).status).toBe('complete');
      expect(mockLlama.ownershipHighWater).toBe(1);
      expect(labeled(root, 'Stop agent')).toBeUndefined();
      expect(composerText(root)).toBe('');
    } finally {
      acknowledgeSave?.();
      act(() => tree.unmount());
    }
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

  it('applies global bypass to a waiting local approval and restores prompts when tightened', async () => {
    const { tree, root, runtime, store } = await renderShell();
    const api = store.get(apiClientAtom);
    if (!api) {
      throw new Error('The local API did not start.');
    }
    mockLlama.reply(
      { toolCalls: [{ name: 'git_push', arguments: {} }] },
      { content: 'Pushed with bypass.' },
    );
    await submit(root, 'Push my branch');
    expect(labeled(root, 'Allow')).toBeDefined();
    expect(mockNative.calls).not.toContain('pushWorkspaceGit:["ws-one"]');

    await act(async () => {
      await api.setApprovalPolicy('never');
      store.set(approvalModeAtom, 'none');
      await flush();
    });
    await settle();
    expect(mockNative.calls.filter((call) => call === 'pushWorkspaceGit:["ws-one"]')).toHaveLength(
      1,
    );
    expect(labeled(root, 'Allow')).toBeUndefined();
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(transcript(root)).toContain('Pushed with bypass.');
    expect(runtime.loop.snapshot()).toMatchObject({ phase: 'idle', approval: null });
    expect(runtime.threads.list()[0]?.status).toBe('complete');

    await act(async () => {
      store.set(approvalModeAtom, 'all');
      await api.setApprovalPolicy('untrusted');
    });
    mockLlama.holdCompletions = true;
    mockLlama.reply(
      { toolCalls: [{ name: 'git_push', arguments: {} }] },
      { content: 'The second push was declined.' },
    );
    await submit(root, 'Push again');
    await drive(() => mockLlama.finishCompletion());
    expect(labeled(root, 'Allow')).toBeDefined();
    expect(labeled(root, 'Stop agent')).toBeDefined();
    expect(drawerStatus(root)).toContain('Waiting for your approval');
    expect(mockNative.calls.filter((call) => call === 'pushWorkspaceGit:["ws-one"]')).toHaveLength(
      1,
    );
    act(() => store.set(showToolCallsAtom, false));
    expect(root.findAllByType(ToolInvocationRow)).toHaveLength(0);
    expect(labeled(root, 'Allow')).toBeDefined();
    expect(labeled(root, 'Stop agent')).toBeDefined();
    act(() => store.set(showToolCallsAtom, true));
    expect(root.findAllByType(ToolInvocationRow).length).toBeGreaterThan(0);
    await press(root, 'Deny');
    expect(labeled(root, 'Allow')).toBeUndefined();
    expect(labeled(root, 'Stop agent')).toBeDefined();
    expect(deniedPushCopies(root)).toBe(1);
    await drive(() => mockLlama.finishCompletion());
    expect(labeled(root, 'Allow')).toBeUndefined();
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(composerText(root)).toBe('');
    expect(runtime.loop.snapshot()).toMatchObject({ phase: 'idle', approval: null });
    expect(deniedPushCopies(root)).toBe(1);
    expect(mockNative.calls.filter((call) => call === 'pushWorkspaceGit:["ws-one"]')).toHaveLength(
      1,
    );
    act(() => tree.unmount());
  });

  it('renders the next request once and settles every control after stopping a tool approval', async () => {
    const { tree, root, runtime, store } = await renderShell({
      files: { 'ws-one:seed.txt': 'fixture\n' },
    });
    mockLlama.reply(
      { toolCalls: [{ name: 'read_file', arguments: { path: 'seed.txt' } }] },
      { content: 'First chat read.' },
    );
    await submit(root, 'Read seed.txt first.');
    await act(async () => {
      store.set(startNewChatAtom);
      await flush();
    });
    await settle();
    mockLlama.reply({ toolCalls: [{ name: 'git_push', arguments: {} }] });
    await submit(root, 'Push my branch');
    expect(labeled(root, 'Allow')).toBeTruthy();
    await press(root, 'Stop agent');
    expect(labeled(root, 'Allow')).toBeUndefined();
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(transcript(root).filter((value) => value === 'Push my branch')).toHaveLength(1);

    mockLlama.holdCompletions = true;
    mockLlama.reply(
      { toolCalls: [{ name: 'read_file', arguments: { path: 'seed.txt' } }] },
      { content: 'The current file contains fixture.' },
    );
    const request = 'Read seed.txt instead.';
    await submit(root, request);
    await settle(20_000);
    expect(transcript(root).filter((value) => value === request)).toHaveLength(1);
    expect(labeled(root, 'Stop agent')).toBeTruthy();
    await drive(() => mockLlama.finishCompletion());
    expect(transcript(root).filter((value) => value === request)).toHaveLength(1);
    await drive(() => mockLlama.finishCompletion());
    expect(runtime.threads.list()[0]?.status).toBe('complete');
    expect(transcript(root).filter((value) => value === request)).toHaveLength(1);
    expect(store.get(activeChatAtom)?.status).toBe('idle');
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(labeled(root, 'Stopping agent')).toBeUndefined();
    expect(drawerStatus(root)).toBe('Qwen3 1.7B Q4_K_M · ready on this iPhone');
    expect(composerText(root)).toBe('');
    const next = transcript(root).indexOf(request);
    expect(transcript(root).slice(0, next)).not.toContain('Turn stopped by user.');
    expect(
      mockNative.calls.filter(
        (value) =>
          value.startsWith('readWorkspaceFile:') &&
          !/\["ws-one","(?:AGENTS|CLAUDE)\.md"\]$/u.test(value),
      ),
    ).toEqual([
      'readWorkspaceFile:["ws-one","seed.txt"]',
      'readWorkspaceFile:["ws-one","seed.txt"]',
    ]);
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

  it('keeps an open chat, its Git, and the new-chat default on their workspace through renames', async () => {
    const { tree, root, store, runtime } = await renderShell({
      workspaces: [
        { id: 'ws-one', name: 'Demo', isRepository: true },
        { id: 'ws-two', name: 'Scratch', isRepository: true },
      ],
    });
    const demo = '/On this iPhone/Demo';
    await act(async () => {
      await store.set(selectManagedWorkspaceAtom, demo);
      await flush();
    });
    await settle();
    mockLlama.reply({ content: 'The workspace holds a demo app.' });
    await submit(root, 'Explain the workspace');
    expect(transcript(root)).toContain('The workspace holds a demo app.');
    const [thread] = runtime.threads.list();
    expect(thread?.workspaceId).toBe('ws-one');
    expect(store.get(activeChatAtom)?.cwd).toBe(demo);

    // Another workspace cannot be renamed onto this one's name and take over its path.
    let renamed = true;
    await act(async () => {
      renamed = await store.set(renameManagedWorkspaceAtom, {
        path: '/On this iPhone/Scratch',
        name: 'demo',
      });
      await flush();
    });
    await settle();
    expect(renamed).toBe(false);
    expect(runtime.workspaces().map((workspace) => workspace.name)).toEqual(['Demo', 'Scratch']);
    expect(store.get(defaultStartCwdAtom)).toBe(demo);
    expect(store.get(activeChatAtom)?.cwd).toBe(demo);

    // Renaming the chat's own workspace moves the open chat and the default to its new path, even
    // when new chats would otherwise fall back elsewhere once the old path stops resolving.
    const moved = '/On this iPhone/Renamed';
    await act(async () => {
      await runtime.selectWorkspace('ws-two');
      await flush();
    });
    await settle();
    expect(store.get(defaultStartCwdAtom)).toBe(demo);
    await act(async () => {
      renamed = await store.set(renameManagedWorkspaceAtom, { path: demo, name: 'Renamed' });
      await flush();
    });
    await settle();
    expect(renamed).toBe(true);
    expect(store.get(activeChatAtom)?.cwd).toBe(moved);
    expect(store.get(defaultStartCwdAtom)).toBe(moved);

    // The chat keeps sending in place, and Git from it reads the same workspace.
    mockLlama.reply({ content: 'Still here.' });
    await submit(root, 'Keep going');
    expect(transcript(root)).toContain('Still here.');
    expect(hasText(root, 'Start a new chat')).toBe(false);
    expect(hasText(root, 'no longer on this iPhone')).toBe(false);
    expect(runtime.threads.list()).toHaveLength(1);
    const api = store.get(apiClientAtom)!;
    await act(async () => {
      await expect(
        api.gitStatus(store.get(activeChatAtom)?.cwd ?? undefined),
      ).resolves.toMatchObject({ cwd: moved });
    });
    expect(mockNative.calls).toContain('getWorkspaceGitStatus:["ws-one"]');
    act(() => tree.unmount());
  });

  it('surfaces set-aside files and failed writes in the drawer and Settings until resolved', async () => {
    const { tree, root, runtime } = await renderShell({
      documents: { 'thread-00000000-0000-4000-8000-000000000999.json': '{damaged' },
    });
    // A damaged conversation no longer blocks the profile; the notice says what happened.
    const notice = '1 damaged local conversation was set aside with its data preserved.';
    expect(hasText(root, notice)).toBe(true);
    expect(drawerStatus(root)).toBe('1 issue needs attention');
    await press(root, 'Dismiss');
    expect(hasText(root, notice)).toBe(false);
    expect(drawerStatus(root)).toBe('Qwen3 1.7B Q4_K_M · loads when you send');

    // A failed write stays visible with a retry instead of being lost or mislabeled.
    mockNative.failRuntimeWrites('The disk is full.');
    await act(async () => {
      await runtime.selectWorkspace('ws-one').catch(() => undefined);
      await flush();
    });
    await settle();
    expect(hasText(root, 'The disk is full.')).toBe(true);
    expect(drawerStatus(root)).toBe('1 issue needs attention');
    mockNative.failRuntimeWrites(null);
    await press(root, 'Retry saving');
    expect(hasText(root, 'The disk is full.')).toBe(false);
    expect(drawerStatus(root)).toBe('Qwen3 1.7B Q4_K_M · loads when you send');
    act(() => tree.unmount());
  });

  it('keeps new-chat setup, presence, and workspace selection consistent after deleting its default', async () => {
    const { tree, root, store, runtime } = await renderShell({
      workspaces: [
        { id: 'ws-one', name: 'Demo', isRepository: true },
        { id: 'ws-two', name: 'Scratch', isRepository: true },
      ],
    });
    await act(async () => {
      await store.set(selectManagedWorkspaceAtom, '/On this iPhone/Scratch');
      await flush();
    });
    await settle();
    expect(hasText(root, 'Needs a workspace')).toBe(false);
    await act(async () => {
      expect(await store.set(deleteManagedWorkspaceAtom, '/On this iPhone/Scratch')).toBe(true);
      await flush();
    });
    await settle();
    expect(runtime.preferences().workspaceId).toBeNull();
    expect(store.get(defaultStartCwdAtom)).toBe('/On this iPhone/Demo');
    expect(labeled(root, 'Workspace, /On this iPhone/Demo')).toBeTruthy();
    expect(hasText(root, 'Needs a workspace')).toBe(false);
    expect(
      labeled(root, 'Where agents run, On this iPhone, Ready · Private offline models'),
    ).toBeTruthy();
    await act(async () => {
      expect(await store.set(deleteManagedWorkspaceAtom, '/On this iPhone/Demo')).toBe(true);
      await flush();
    });
    await settle();
    expect(store.get(defaultStartCwdAtom)).toBeNull();
    expect(hasText(root, 'Needs a workspace')).toBe(true);
    act(() => tree.unmount());
  });
});
