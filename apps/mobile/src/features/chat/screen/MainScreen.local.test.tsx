jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(() => null, { glyphMap: {} }),
}));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('react-native-markdown-display', () => 'Markdown');
jest.mock('../message/ChatMessage', () => ({
  ChatMessage: ({ message }: { message: { content: string } }) => message.content,
  ToolInvocationRow: ({ invocation }: { invocation: { title: string } }) =>
    `tool:${invocation.title}`,
}));
jest.mock('./AtomGlyph', () => ({ AtomGlyph: () => null }));

import { AccessibilityInfo, AppState, FlatList, Text, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { HostBridgeApiClient } from '@bridge/client/client';
import { getMessageText } from '@bridge/messages';
import type { ChatMessage } from '@bridge/types/types';
import { LocalBridgeServer } from '../../on-device/transport/server';
import { FakeAgentPort } from '../../on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../on-device/transport/wire';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { router } from 'expo-router';
import { LOCAL_SETUP_DESTINATIONS } from '@shell/profiles/localSetup';
import { localAgentPresenceAtom } from '@shell/state/local/atoms';
import { MainScreen } from './MainScreen';
import { selectedChatIdAtom } from '../state/session';

type Node = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Node) => boolean): Node[];
  findAllByType(type: unknown): Node[];
};

async function flush(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await flush();
    jest.advanceTimersByTime(50);
    await flush();
  });
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

async function press(node: Node | undefined): Promise<void> {
  if (!node) {
    throw new Error('Missing control');
  }
  await act(async () => {
    (node.props['onPress'] as () => void)();
    await flush();
  });
  await settle();
}

async function renderLocalMain() {
  const port = new FakeAgentPort();
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
  store.set(defaultStartCwdAtom, `${LOCAL_WORKSPACE_ROOT}/Demo`);
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
            <MainScreen />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await flush();
  });
  await settle();
  return { tree: tree!, root: tree!.root as Node, port, store, ws };
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

describe('MainScreen on the local profile', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts a local chat, streams the reply into the transcript, and stops it', async () => {
    const { tree, root, port, store } = await renderLocalMain();
    expect(
      root
        .findAllByType(TextInput)
        .some((node) => node.props['placeholder'] === 'Message On this iPhone...'),
    ).toBe(true);
    const attach = labeled(root, 'Add attachment');
    expect(attach?.props['accessibilityState']).toMatchObject({ disabled: true });

    await submit(root, 'Explain the workspace');

    const [thread] = port.threads();
    expect(thread).toMatchObject({
      workspaceId: 'ws-one',
      modelId: 'qwen3-1.7b-q4-k-m',
      status: 'running',
    });
    expect(store.get(selectedChatIdAtom)).toBe(thread!.id);
    expect(transcript(root)).toContain('Explain the workspace');

    await act(async () => {
      port.streamAssistant(thread!.id, 'assistant-1', 'The workspace');
      await flush();
    });
    await act(async () => {
      port.streamAssistant(thread!.id, 'assistant-1', 'The workspace holds a demo app.');
      await flush();
    });
    await settle();
    expect(transcript(root)).toContain('The workspace holds a demo app.');
    expect(labeled(root, 'Stop agent')).toBeTruthy();

    await act(async () => {
      (labeled(root, 'Stop agent')!.props['onPress'] as () => void)();
      await flush();
    });
    await settle();

    expect(port.thread(thread!.id)?.status).toBe('interrupted');
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    expect(transcript(root)).toEqual(
      expect.arrayContaining(['Explain the workspace', 'The workspace holds a demo app.']),
    );
    act(() => tree.unmount());
  });

  it('shows what the local run is doing: model load progress, generating, then the tool', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    announce.mockClear();
    const { tree, root, port } = await renderLocalMain();
    // As in the real loop, the model loads before the message is recorded and the thread runs.
    port.holdModelLoad = true;
    await submit(root, 'Read the README');
    const [thread] = port.threads();
    expect(thread?.status).toBe('idle');

    await act(async () => {
      port.setModel({ phase: 'loading', modelId: 'qwen3-1.7b-q4-k-m', progress: 42 });
      await flush();
    });
    await settle();
    expect(hasText(root, 'Loading Qwen3 1.7B')).toBe(true);
    expect(hasText(root, ' · 42%')).toBe(true);
    expect(hasText(root, 'Sending message')).toBe(false);
    expect(labeled(root, 'Stop agent')).toBeTruthy();

    await act(async () => {
      port.setModel({ phase: 'ready', progress: 100 });
      port.finishModelLoad();
      port.streamAssistant(thread!.id, 'assistant-1', 'Let me look.');
      await flush();
    });
    await settle();
    expect(port.thread(thread!.id)?.status).toBe('running');
    expect(hasText(root, 'Loading Qwen3 1.7B')).toBe(false);

    await act(async () => {
      port.startTool(thread!.id, 'assistant-1', 'call-1', 'read_file', '{"path":"README.md"}');
      await flush();
    });
    await settle();
    expect(hasText(root, 'Reading README.md')).toBe(true);

    await act(async () => {
      port.finishTool(thread!.id, 'call-1', '{"content":"hi"}', 'completed');
      port.streamAssistant(thread!.id, 'assistant-2', 'It says hi.');
      port.settle(thread!.id, 'complete');
      await flush();
    });
    await settle();
    expect(hasText(root, 'Reading README.md')).toBe(false);
    expect(hasText(root, 'Generating')).toBe(false);
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    const spoken = announce.mock.calls.map(([message]) => message);
    expect(spoken).toEqual(
      expect.arrayContaining(['Loading Qwen3 1.7B', 'Generating', 'Reading README.md']),
    );
    expect(spoken.filter((message) => message === 'Turn completed')).toHaveLength(1);
    expect(spoken).not.toContain('Sending message');
    expect(spoken).not.toContain('Opening chat');
    // Load progress is shown, not re-announced for every percent.
    expect(spoken.filter((message) => message.startsWith('Loading'))).toHaveLength(1);
    announce.mockRestore();
    act(() => tree.unmount());
  });

  it('keeps the draft and ends the run when the model fails to load', async () => {
    const { tree, root, port } = await renderLocalMain();
    port.holdModelLoad = true;
    await submit(root, 'Explain the workspace');
    const [thread] = port.threads();
    await act(async () => {
      port.setModel({ phase: 'loading', modelId: 'qwen3-1.7b-q4-k-m', progress: 10 });
      await flush();
    });
    await settle();
    expect(hasText(root, 'Loading Qwen3 1.7B')).toBe(true);

    await act(async () => {
      port.failModelLoad('Not enough memory to load Qwen3 1.7B.');
      await flush();
    });
    await settle();
    expect(port.thread(thread!.id)?.messages).toEqual([]);
    expect(hasText(root, 'Not enough memory to load Qwen3 1.7B.')).toBe(true);
    expect(hasText(root, 'Loading Qwen3 1.7B')).toBe(false);
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    act(() => tree.unmount());
  });

  it('surfaces a failed local turn in the composer and retries it in place', async () => {
    const { tree, root, port } = await renderLocalMain();
    await submit(root, 'Add a license');
    const [thread] = port.threads();
    await act(async () => {
      port.settle(thread!.id, 'failed', 'The local context window is full.');
      await flush();
    });
    await settle();

    const failure = root.findAll((node) => node.props['testID'] === 'composer-turn-failure')[0];
    expect(failure).toBeTruthy();
    expect(hasText(root, 'The local context window is full.')).toBe(true);
    expect(labeled(root, 'Stop agent')).toBeUndefined();

    await press(labeled(root, 'Retry turn'));

    expect(port.calls).toContain(`retry:${thread!.id}`);
    expect(port.thread(thread!.id)?.status).toBe('running');
    expect(
      port.thread(thread!.id)?.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(1);
    expect(labeled(root, 'Retry turn')).toBeUndefined();
    expect(hasText(root, 'The local context window is full.')).toBe(false);
    expect(labeled(root, 'Stop agent')).toBeTruthy();

    await act(async () => {
      port.streamAssistant(thread!.id, 'assistant-1', 'Added LICENSE.');
      port.settle(thread!.id, 'complete');
      await flush();
    });
    await settle();
    expect(transcript(root)).toContain('Added LICENSE.');
    expect(labeled(root, 'Retry turn')).toBeUndefined();
    expect(labeled(root, 'Stop agent')).toBeUndefined();
    act(() => tree.unmount());
  });

  it('answers a local tool approval from the shared banner, including Deny', async () => {
    const { tree, root, port } = await renderLocalMain();
    await submit(root, 'Push my branch');
    const [thread] = port.threads();
    await act(async () => {
      port.requestApproval(thread!.id, 'call-push', 'git_push', 'Push main to origin');
      await flush();
    });
    await settle();
    expect(hasText(root, 'Push main to origin')).toBe(true);

    await press(labeled(root, 'Deny'));

    expect(port.approvals).toEqual([{ callId: 'call-push', approved: false }]);
    expect(labeled(root, 'Deny')).toBeUndefined();
    expect(labeled(root, 'Stop agent')).toBeTruthy();
    act(() => tree.unmount());
  });

  it('explains why a new local chat cannot start and offers the next step', async () => {
    const { tree, root, store } = await renderLocalMain();
    await act(async () => {
      store.set(localAgentPresenceAtom, {
        status: { label: 'Choose a model', kind: 'attention' },
        readiness: {
          reason: 'Download Qwen3 1.7B Q4_K_M to start a conversation.',
          action: 'download-model',
        },
        defaultWorkspacePath: null,
      });
      await flush();
    });
    await settle();
    expect(hasText(root, 'Download Qwen3 1.7B Q4_K_M to start a conversation.')).toBe(true);
    expect(labeled(root, 'Get a model')).toBeTruthy();
    expect(labeled(root, 'Use suggestion: Write tests')).toBeUndefined();
    await press(labeled(root, 'Get a model'));
    expect(router.push).toHaveBeenCalledWith(LOCAL_SETUP_DESTINATIONS.models);

    await act(async () => {
      store.set(localAgentPresenceAtom, {
        status: { label: 'Qwen3 1.7B Q4_K_M · loads when you send', kind: 'ready' },
        readiness: null,
        defaultWorkspacePath: null,
      });
      await flush();
    });
    await settle();
    expect(labeled(root, 'Get a model')).toBeUndefined();
    expect(labeled(root, 'Use suggestion: Write tests')).toBeTruthy();
    act(() => tree.unmount());
  });
});
