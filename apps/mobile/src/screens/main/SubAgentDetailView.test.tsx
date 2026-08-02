import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
jest.mock('expo-router', () => jest.requireActual('../../testing/expoRouterMock'));
jest.mock('react-native-reanimated', () => jest.requireActual('../../testing/reanimatedMock'));
import { router } from 'expo-router';

import type { HostBridgeApiClient } from '../../api/client';
import { createAgUiThreadMessageState } from '../../api/agUi';
import type { Chat, RpcNotification } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { liveAssistantByThreadAtom } from '../../state/mainScreen/turn';
import { threadRuntimeSnapshotsAtom } from '../../state/mainScreen/runtime';
import { agentRootThreadIdAtom, relatedAgentThreadsAtom } from '../../state/mainScreen/workspace';
import { createBridgeTestStore, withAppStore } from '../../state/testing';
import type { AppStore } from '../../state/types';
import { createAppTheme, AppThemeProvider } from '../../theme';
import { ChatTranscriptView } from './ChatTranscriptView';
import { SubAgentDetailView } from './SubAgentDetailView';
import { routes } from '../../navigation/routes';

const theme = createAppTheme('dark');

function chat(messages: Chat['messages'] = []): Chat {
  return {
    id: 'child',
    title: 'Research dependency options',
    status: 'running',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    lastMessagePreview: '',
    messages,
  };
}

interface RenderOptions {
  loadedChat?: Chat;
  cachedChat?: Chat | null;
  getChat?: jest.Mock;
}

async function render(options: RenderOptions = {}): Promise<{
  tree: ReactTestRenderer;
  store: AppStore;
  api: HostBridgeApiClient;
  emit: (event: RpcNotification) => void;
}> {
  const loadedChat = options.loadedChat ?? chat();
  const cachedChat = options.cachedChat === undefined ? loadedChat : options.cachedChat;
  const getChat =
    options.getChat ??
    jest.fn((threadId: string) =>
      threadId === loadedChat.id
        ? Promise.resolve(loadedChat)
        : Promise.reject(new Error(`Unknown thread ${threadId}`)),
    );
  const api = {
    getChat,
    peekChat: jest.fn((threadId: string) => (threadId === loadedChat.id ? cachedChat : null)),
    peekChatShell: jest.fn(() => null),
    peekChatSummary: jest.fn((threadId: string) =>
      threadId === loadedChat.id ? loadedChat : null,
    ),
  } as unknown as HostBridgeApiClient;
  let eventListener: ((event: RpcNotification) => void) | null = null;
  const ws = {
    onEvent: jest.fn((listener: (event: RpcNotification) => void) => {
      eventListener = listener;
      return () => {
        if (eventListener === listener) eventListener = null;
      };
    }),
  } as unknown as HostBridgeWsClient;
  const store = createBridgeTestStore({ api, ws });
  store.set(agentRootThreadIdAtom, 'root');
  store.set(relatedAgentThreadsAtom, [loadedChat]);
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
            <SubAgentDetailView threadId={loadedChat.id} />
          </AppThemeProvider>
        </SafeAreaProvider>,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  if (!tree) throw new Error('render failed');
  return {
    tree,
    store,
    api,
    emit: (event) => eventListener?.(event),
  };
}

type Queryable = ReactTestInstance & {
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

function countByLabel(tree: ReactTestRenderer, label: string): number {
  return (tree.root as Queryable).findAll((node) => node.props.accessibilityLabel === label).length;
}

function isStarting(tree: ReactTestRenderer): boolean {
  return countByLabel(tree, 'Sub-agent starting') > 0;
}

function renderedText(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON());
}

describe('SubAgentDetailView starting state', () => {
  it('hydrates the route and reports a sub-agent that has not produced anything as starting', async () => {
    // A just-spawned sub-agent has no transcript. An empty scroll view makes a
    // live agent look dead.
    const { api, tree } = await render();
    expect(api.getChat).toHaveBeenCalledWith('child', { forceRefresh: true });
    expect(isStarting(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('drops the starting state the moment streamed text arrives', async () => {
    // The card becomes openable before the child has said anything, so the page
    // has to switch to the transcript as soon as the bridge streams a token.
    const { store, tree } = await render();
    act(() => {
      store.set(liveAssistantByThreadAtom, {
        child: {
          ...createAgUiThreadMessageState(),
          messages: [
            {
              id: 'live-child',
              role: 'assistant',
              content: 'Reading package.json',
              createdAt: '2026-07-20T00:00:01.000Z',
            },
          ],
        },
      });
    });
    expect(isStarting(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('drops the starting state once a persisted message exists', async () => {
    const { tree } = await render({
      loadedChat: chat([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Found three options',
          createdAt: '2026-07-20T00:00:01.000Z',
        },
      ]),
    });
    expect(isStarting(tree)).toBe(false);
    act(() => tree.unmount());
  });

  it('never shows a starting state for a sub-agent that has already finished', async () => {
    // Regression: a finished sub-agent that left no transcript spun on "Starting…"
    // forever, because the state was derived from the message count alone.
    for (const status of ['complete', 'idle', 'error'] as const) {
      const { tree } = await render({ loadedChat: { ...chat(), status } });
      expect(isStarting(tree)).toBe(false);
      expect(countByLabel(tree, 'Sub-agent reported no transcript')).toBeGreaterThan(0);
      act(() => tree.unmount());
    }
  });

  it('still reports a running sub-agent with no transcript as starting', async () => {
    const { tree } = await render({ loadedChat: { ...chat(), status: 'running' } });
    expect(isStarting(tree)).toBe(true);
    expect(countByLabel(tree, 'Sub-agent reported no transcript')).toBe(0);
    act(() => tree.unmount());
  });

  it('shows the loading shell instead of a starting state before the chat resolves', async () => {
    const { tree } = await render({
      cachedChat: null,
      getChat: jest.fn(() => new Promise<Chat>(() => {})),
    });
    expect(isStarting(tree)).toBe(false);
    expect(countByLabel(tree, 'Loading agent transcript')).toBeGreaterThan(0);
    act(() => tree.unmount());
  });

  it('does not replace initial hydration when snapshot recovery arrives', async () => {
    let resolveChat!: (value: Chat) => void;
    const getChat = jest.fn(
      () =>
        new Promise<Chat>((resolve) => {
          resolveChat = resolve;
        }),
    );
    const { emit, tree } = await render({ cachedChat: null, getChat });

    act(() => emit({ method: 'bridge/events/snapshotRequired', params: {} }));
    expect(getChat).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveChat(chat());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(isStarting(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('retries hydration when an early-opened sub-agent is adopted', async () => {
    const getChat = jest
      .fn()
      .mockRejectedValueOnce(new Error('Thread is not available yet'))
      .mockResolvedValueOnce(chat());
    const { emit, tree } = await render({ cachedChat: null, getChat });
    expect(countByLabel(tree, 'Loading agent transcript')).toBeGreaterThan(0);

    await act(async () => {
      emit({ method: 'thread/subagent/adopted', params: { threadId: 'child' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getChat).toHaveBeenCalledTimes(2);
    expect(isStarting(tree)).toBe(true);
    act(() => tree.unmount());
  });

  it('renders the same rich runtime status as the agent selector', async () => {
    const { store, tree } = await render();
    act(() => {
      store.set(threadRuntimeSnapshotsAtom, {
        child: {
          activity: { tone: 'running', title: 'Reasoning', detail: 'Inspecting dependencies' },
          pendingApproval: {} as never,
          updatedAtMs: Date.now(),
        },
      });
    });

    expect(renderedText(tree)).toContain('Needs approval');
    expect(renderedText(tree)).toContain('Inspecting dependencies');
    act(() => tree.unmount());
  });

  it('keeps a hydrated transcript quiet when background recovery refresh fails', async () => {
    const loadedChat = chat([
      {
        id: 'message-1',
        role: 'assistant',
        content: 'Existing transcript',
        createdAt: '2026-07-20T00:00:01.000Z',
      },
    ]);
    const getChat = jest
      .fn()
      .mockResolvedValueOnce(loadedChat)
      .mockRejectedValueOnce(new Error('Background refresh failed'));
    const { emit, tree } = await render({ loadedChat, getChat });

    await act(async () => {
      emit({ method: 'bridge/events/snapshotRequired', params: {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getChat).toHaveBeenCalledTimes(2);
    expect(renderedText(tree)).not.toContain('Background refresh failed');
    expect(renderedText(tree)).toContain('Existing transcript');
    act(() => tree.unmount());
  });

  it('does not rehydrate an already loaded thread when adoption arrives', async () => {
    const { api, emit, tree } = await render();
    await act(async () => {
      emit({ method: 'thread/subagent/adopted', params: { threadId: 'child' } });
      await Promise.resolve();
    });

    expect(api.getChat).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('pushes nested sub-agent routes and pops back one route', async () => {
    const { tree } = await render({
      loadedChat: chat([
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Working on the parent task',
          createdAt: '2026-07-20T00:00:01.000Z',
        },
      ]),
    });
    const transcript = tree.root.findByType(ChatTranscriptView);
    const openSubAgentThread = transcript.props.onOpenSubAgentThread as
      ((threadId: string) => void) | undefined;

    act(() => openSubAgentThread?.('grandchild'));
    expect(router.push).toHaveBeenCalledWith(routes.agent('profile-1', 'new', 'grandchild'));

    const back = (tree.root as Queryable).findAll(
      (node) => node.props.accessibilityLabel === 'Back from sub-agent transcript',
    )[0];
    const pressBack = back.props.onPress as () => void;
    act(() => pressBack());
    expect(router.back).toHaveBeenCalled();
    act(() => tree.unmount());
  });
});
