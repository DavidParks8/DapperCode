import type * as ReactModule from 'react';
import type * as MessagesModule from '@bridge/messages';

jest.mock('expo-router', () => {
  const actual = jest.requireActual('@shared/testing/expoRouterMock');
  const React = jest.requireActual<typeof ReactModule>('react');
  return {
    ...actual,
    useFocusEffect: (effect: () => void | (() => void)) => {
      React.useEffect(() => effect(), [effect]);
    },
  };
});
jest.mock('expo-router/react-navigation', () => ({ usePreventRemove: jest.fn() }));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: Object.assign(() => null, { glyphMap: {} }),
}));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));
jest.mock('react-native-markdown-display', () => 'Markdown');
// Each rendered sub-agent card's open action, keyed by the thread it opens.
const mockCards = new Map<string, () => void>();
jest.mock('../message/ChatMessage', () => {
  const messages = jest.requireActual<typeof MessagesModule>('@bridge/messages');
  return {
    ChatMessage: ({
      message,
      onOpenSubAgentThread,
    }: {
      message: Parameters<typeof messages.getMessageText>[0];
      onOpenSubAgentThread?: (threadId: string) => void;
    }) => {
      const threadId = messages.getSubAgentThreadId(message as never);
      if (threadId && onOpenSubAgentThread) {
        mockCards.set(threadId, () => onOpenSubAgentThread(threadId));
      }
      return messages.getMessageText(message);
    },
    ToolInvocationRow: ({ invocation }: { invocation: { title: string } }) =>
      `tool:${invocation.title}`,
  };
});
jest.mock('../screen/AtomGlyph', () => ({ AtomGlyph: () => null }));

import { AppState, TextInput } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { router } from 'expo-router';

import { HostBridgeApiClient } from '@bridge/client/client';
import { LocalBridgeServer } from '../../on-device/transport/server';
import { localChildThreadId } from '../../on-device/transport/children';
import { FakeAgentPort } from '../../on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../on-device/transport/wire';
import type { LocalChild } from '../../on-device/runtime/types';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { routes } from '@shell/navigation/routes';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import type { AppStore } from '@shell/state/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { MainScreen } from '../screen/MainScreen';
import { SubAgentDetailView } from './SubAgentDetailView';

type Node = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Node) => boolean): Node[];
  findAllByType(type: unknown): Node[];
};

const CHILD = localChildThreadId('child-1');

/** Records the task child's new state on the parent's `task` message, as delegation does. */
function putChild(port: FakeAgentPort, parentId: string, child: LocalChild): void {
  const parent = port.thread(parentId)!;
  port.put({
    ...parent,
    messages: parent.messages.map((message) =>
      message.tool?.callId === 'call-task' ? { ...message, children: [child] } : message,
    ),
  });
}
const at = (second: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();

const searching: LocalChild = {
  id: 'child-1',
  agent: 'explore',
  workspaceId: 'ws-one',
  modelId: 'qwen3-1.7b-q4-k-m',
  status: 'running',
  updatedAt: at(3),
  lastError: null,
  messages: [
    { id: 'user-one', role: 'user', content: 'Find TODO comments', createdAt: at(1) },
    {
      id: 'child-assistant-1',
      role: 'assistant',
      content: 'Searching the sources.',
      createdAt: at(2),
      toolCalls: [
        {
          id: 'child-call-1',
          type: 'function',
          function: { name: 'search_files', arguments: '{"query":"TODO"}' },
        },
      ],
    },
    {
      id: 'tool-child-call-1',
      role: 'tool',
      content: '',
      createdAt: at(3),
      tool: { callId: 'child-call-1', name: 'search_files', status: 'running', startedAt: at(3) },
    },
  ],
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

async function update(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await flush();
  });
  await settle();
}

type RenderedNode = { children?: (RenderedNode | string)[] | null } | string | null;

function rendered(tree: ReactTestRenderer): string {
  const collect = (node: RenderedNode): string[] =>
    typeof node === 'string' ? [node] : (node?.children ?? []).flatMap(collect);
  const output = (tree as unknown as { toJSON: () => RenderedNode | RenderedNode[] }).toJSON();
  return (Array.isArray(output) ? output : [output]).flatMap(collect).join('\n');
}

async function mount(store: AppStore, element: React.ReactElement): Promise<ReactTestRenderer> {
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
          <AppThemeProvider theme={createAppTheme('dark')}>{element}</AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await flush();
  });
  await settle();
  return tree!;
}

async function submit(root: Node, text: string): Promise<void> {
  const input = root
    .findAllByType(TextInput)
    .find((node) => node.props['accessibilityLabel'] === 'Message');
  const composer = root.findAll(
    (node) =>
      typeof node.props['onSubmit'] === 'function' &&
      typeof node.props['onChangeText'] === 'function',
  )[0];
  if (!input || !composer) {
    throw new Error('Missing composer');
  }
  await update(() => (input.props['onChangeText'] as (value: string) => void)(text));
  await update(() => (composer.props['onSubmit'] as () => void)());
}

describe('On this iPhone task children', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockCards.clear();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('opens a running child from its card and watches its transcript stream live', async () => {
    const port = new FakeAgentPort();
    const ws = new LocalBridgeWsClient(new LocalBridgeServer(port));
    ws.connect();
    const api = new HostBridgeApiClient({
      ws,
      profileId: LOCAL_PROFILE_ID,
      modelListCacheTtlMs: 0,
    });
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
    const main = await mount(store, <MainScreen />);

    await submit(main.root as Node, 'Survey the repository');
    const parentId = port.threads()[0]!.id;
    await update(() => {
      port.streamAssistant(parentId, 'assistant-1', '');
      port.startTool(parentId, 'assistant-1', 'call-task', 'task', '{"tasks":[]}');
      putChild(port, parentId, searching);
    });

    // The parent transcript shows the child as an openable sub-agent card.
    expect(rendered(main)).toContain('Sub-agent working');
    const open = mockCards.get(CHILD);
    expect(open).toBeDefined();
    await update(() => open!());
    expect(router.push).toHaveBeenLastCalledWith(routes.agent(LOCAL_PROFILE_ID, parentId, CHILD));

    // The pushed route renders the child's own transcript, read from the local transport.
    const detail = await mount(store, <SubAgentDetailView threadId={CHILD} />);
    expect(rendered(detail)).toContain('Find TODO comments');
    expect(rendered(detail)).toContain('Searching the sources.');
    expect(rendered(detail)).not.toContain('Found one TODO');

    // While it stays open, the child's next reply streams into it without reopening.
    await update(() =>
      putChild(port, parentId, {
        ...searching,
        updatedAt: at(5),
        messages: [
          ...searching.messages,
          {
            id: 'child-assistant-2',
            role: 'assistant',
            content: 'Found one TODO in src/app.ts.',
            createdAt: at(5),
          },
        ],
      }),
    );
    expect(rendered(detail)).toContain('Found one TODO in src/app.ts.');

    act(() => detail.unmount());
    act(() => main.unmount());
    ws.dispose();
  });
});
