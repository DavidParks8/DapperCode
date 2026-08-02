import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
jest.mock('expo-router', () => jest.requireActual('../../testing/expoRouterMock'));
jest.mock('react-native-reanimated', () => jest.requireActual('../../testing/reanimatedMock'));
import { router } from 'expo-router';

import type { HostBridgeApiClient } from '../../api/client';
import { createAgUiThreadMessageState } from '../../api/agUi';
import { mapChat } from '../../api/chatMapping';
import type { Chat, RpcNotification } from '../../api/types';
import type { HostBridgeWsClient } from '../../api/ws';
import { liveAssistantByThreadAtom } from '../../state/mainScreen/turn';
import { threadRuntimeSnapshotsAtom } from '../../state/mainScreen/runtime';
import { agentRootThreadIdAtom, relatedAgentThreadsAtom } from '../../state/mainScreen/workspace';
import { createBridgeTestStore, withAppStore } from '../../state/testing';
import type { AppStore } from '../../state/types';
import { createAppTheme, AppThemeProvider } from '../../theme';
import { ReasoningEntryCard } from '../../components/chatMessageReasoningCard';
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
        if (eventListener === listener) {
          eventListener = null;
        }
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
  if (!tree) {
    throw new Error('render failed');
  }
  return {
    tree,
    store,
    api,
    emit: (event) => eventListener?.(event),
  };
}

type Queryable = ReactTestInstance & {
  type: unknown;
  children: Array<Queryable | string>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
  findAllByType(type: unknown): Queryable[];
};

function countByLabel(tree: ReactTestRenderer, label: string): number {
  return (tree.root as Queryable).findAll((node) => node.props.accessibilityLabel === label).length;
}

function countByTestId(tree: ReactTestRenderer, testID: string): number {
  return (tree.root as Queryable).findAll((node) => node.props.testID === testID).length;
}

function isStarting(tree: ReactTestRenderer): boolean {
  return countByLabel(tree, 'Sub-agent starting') > 0;
}

function renderedText(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON());
}

function textContent(node: Queryable): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
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

  it('keeps the "Sub-agent" eyebrow readable at theme.typography.metadata size', async () => {
    const { tree } = await render();
    const eyebrow = (tree.root as Queryable).findAll(
      (node) => node.type === Text && textContent(node) === 'Sub-agent',
    )[0];
    if (!eyebrow) {
      throw new Error('Missing "Sub-agent" eyebrow text');
    }
    const style = (StyleSheet.flatten(eyebrow.props.style) ?? {}) as Record<
      string,
      number | string | undefined
    >;

    // Must adopt theme.typography.metadata (11/14) instead of the old sub-11pt literal
    // override (10/12), while keeping its uppercase/bold/muted presentation.
    expect(Number(style.fontSize)).toBe(11);
    expect(Number(style.lineHeight)).toBe(14);
    expect(style.fontWeight).toBe('700');
    expect(style.textTransform).toBe('uppercase');
    expect(style.color).toBe(theme.colors.textMuted);

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

  it('shows a transcript-shaped shimmer until history resolves', async () => {
    jest.useFakeTimers();
    let resolveChat!: (value: Chat) => void;
    const getChat = jest.fn(
      () =>
        new Promise<Chat>((resolve) => {
          resolveChat = resolve;
        }),
    );
    let tree: ReactTestRenderer | null = null;
    try {
      ({ tree } = await render({
        loadedChat: { ...chat(), lastMessagePreview: 'Loaded from history' },
        cachedChat: null,
        getChat,
      }));
      expect(isStarting(tree)).toBe(false);
      expect(countByTestId(tree, 'agent-transcript-shimmer')).toBe(0);
      expect(countByLabel(tree, 'Loading agent transcript')).toBe(0);

      act(() => jest.advanceTimersByTime(120));
      const shimmer = tree.root.findByProps({ testID: 'agent-transcript-shimmer' }) as Queryable;
      expect(shimmer.findAllByType(ActivityIndicator)).toHaveLength(0);

      await act(async () => {
        resolveChat(
          chat([
            {
              id: 'message-1',
              role: 'assistant',
              content: 'Loaded from history',
              createdAt: '2026-07-20T00:00:01.000Z',
            },
          ]),
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(countByTestId(tree, 'agent-transcript-shimmer')).toBeGreaterThan(0);
      expect(renderedText(tree)).toContain('Loaded from history');
      act(() => jest.advanceTimersByTime(350));
      expect(countByLabel(tree, 'Loading agent transcript')).toBe(0);
      expect(countByTestId(tree, 'agent-transcript-shimmer')).toBe(0);
    } finally {
      if (tree) {
        act(() => tree?.unmount());
      }
      jest.useRealTimers();
    }
  });

  it('does not fabricate history for a known-empty running sub-agent', async () => {
    const { tree } = await render({
      cachedChat: null,
      getChat: jest.fn(() => new Promise<Chat>(() => {})),
    });

    expect(isStarting(tree)).toBe(true);
    expect(countByLabel(tree, 'Loading agent transcript')).toBe(0);
    act(() => tree.unmount());
  });

  it('does not fabricate history for a known-empty finished sub-agent', async () => {
    const { tree } = await render({
      loadedChat: { ...chat(), status: 'complete' },
      cachedChat: null,
      getChat: jest.fn(() => new Promise<Chat>(() => {})),
    });

    expect(countByLabel(tree, 'Sub-agent reported no transcript')).toBeGreaterThan(0);
    expect(countByTestId(tree, 'agent-transcript-shimmer')).toBe(0);
    act(() => tree.unmount());
  });

  it('settles on no transcript when preview-only messages are filtered out', async () => {
    const loadedChat = {
      ...chat([
        {
          id: 'message-1',
          role: 'assistant' as const,
          content: 'FINAL_TASK_RESULT_JSON {"result":"reported through parent"}',
          createdAt: '2026-07-20T00:00:01.000Z',
        },
      ]),
      status: 'complete' as const,
      lastMessagePreview: 'FINAL_TASK_RESULT_JSON {"result":"reported through parent"}',
    };
    const { tree } = await render({ loadedChat, cachedChat: null });

    expect(countByLabel(tree, 'Sub-agent reported no transcript')).toBeGreaterThan(0);
    expect(countByLabel(tree, 'Loading agent transcript')).toBe(0);
    act(() => tree.unmount());
  });

  it('skips the shimmer when history resolves inside the grace period', async () => {
    const loadedChat = {
      ...chat([
        {
          id: 'message-1',
          role: 'assistant' as const,
          content: 'Loaded immediately',
          createdAt: '2026-07-20T00:00:01.000Z',
        },
      ]),
      lastMessagePreview: 'Loaded immediately',
    };
    const { tree } = await render({ loadedChat, cachedChat: null });

    expect(countByTestId(tree, 'agent-transcript-shimmer')).toBe(0);
    expect(renderedText(tree)).toContain('Loaded immediately');
    act(() => tree.unmount());
  });

  it('keeps cached transcript history visible during a refresh', async () => {
    const loadedChat = chat([
      {
        id: 'message-1',
        role: 'assistant',
        content: 'Already cached',
        createdAt: '2026-07-20T00:00:01.000Z',
      },
    ]);
    const { tree } = await render({
      loadedChat,
      cachedChat: loadedChat,
      getChat: jest.fn(() => new Promise<Chat>(() => {})),
    });

    expect(countByLabel(tree, 'Loading agent transcript')).toBe(0);
    expect(renderedText(tree)).toContain('Already cached');
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
    expect(isStarting(tree)).toBe(true);

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

describe('SubAgentDetailView transcript ordering', () => {
  // The bridge hands the sub-agent chat an ACP snapshot whose `timeline` carries the
  // source sequence of every entry. A sub-agent adopted mid-run is the case that broke:
  // the reader hydrated it from an `opencode export` while the agent was still streaming,
  // and the replay both restated the reasoning under a second id and filed the prompt
  // after the answer it produced. The bridge now declines that replay, and this locks the
  // client half of the contract: one row per reasoning identity, rendered in source
  // sequence order rather than the order entries happen to sit in the payload.
  function snapshotThread(
    timeline: Array<{ sequence: number; kind: 'message' | 'reasoning'; canonicalId: string }>,
    messages: Array<{ id: string; role: 'user' | 'agent' | 'thought'; text: string }>,
  ) {
    return {
      id: 'child',
      name: 'Harness smoke test',
      createdAt: 1784505600,
      updatedAt: 1784505600,
      acpSnapshot: {
        version: 2,
        timeline,
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          parts: [{ type: 'text', text: message.text }],
          truncated: false,
        })),
        tools: [],
        plan: [],
        usage: { used: null, size: null, cost: null },
        mode: null,
        config: [],
        commands: [],
        session: {
          agentId: 'opencode',
          threadId: 'child',
          title: 'Harness smoke test',
          updatedAt: '2026-07-20T00:00:00.000Z',
          historyReconstruction: false,
        },
        active: { runId: null, sourceTurnId: null, generation: null, toolIds: [] },
      },
    };
  }

  const PROMPT = 'This is a harness test. Please respond with a brief confirmation message.';
  const REASONING = 'The user is asking for a harness test confirmation.';
  const ANSWER = 'Confirmed - read-only smoke test, no files modified.';

  function reasoningCards(tree: ReactTestRenderer): Queryable[] {
    return (tree.root as Queryable).findAllByType(ReasoningEntryCard);
  }

  /** The transcript list is inverted, so the newest row is rendered first. */
  function chronologicalOrder(tree: ReactTestRenderer, needles: string[]): string[] {
    const rendered = renderedText(tree);
    return needles
      .map((needle) => [needle, rendered.indexOf(needle)] as const)
      .filter(([, index]) => index >= 0)
      .sort((left, right) => right[1] - left[1])
      .map(([needle]) => needle);
  }

  it('renders one card per reasoning identity in source sequence order', async () => {
    // The payload deliberately lists the prompt last, the way a late-filed history entry
    // arrives, so array order and sequence order disagree.
    const raw = snapshotThread(
      [
        { sequence: 4, kind: 'reasoning', canonicalId: 'msg_answer::thought' },
        { sequence: 5, kind: 'message', canonicalId: 'msg_answer::agent' },
        { sequence: 3, kind: 'message', canonicalId: 'prompt' },
      ],
      [
        { id: 'prompt', role: 'user', text: PROMPT },
        { id: 'msg_answer::thought', role: 'thought', text: REASONING },
        { id: 'msg_answer::agent', role: 'agent', text: ANSWER },
      ],
    );
    const loadedChat = mapChat(raw);
    const { tree } = await render({ loadedChat });

    expect(reasoningCards(tree)).toHaveLength(1);
    expect(chronologicalOrder(tree, [PROMPT, REASONING, ANSWER])).toEqual([
      PROMPT,
      REASONING,
      ANSWER,
    ]);
    act(() => tree.unmount());
  });

  it('keeps a streaming reasoning turn to one card as it completes', async () => {
    const raw = snapshotThread(
      [
        { sequence: 3, kind: 'message', canonicalId: 'prompt' },
        { sequence: 4, kind: 'reasoning', canonicalId: 'msg_answer::thought' },
      ],
      [
        { id: 'prompt', role: 'user', text: PROMPT },
        { id: 'msg_answer::thought', role: 'thought', text: 'The user is asking' },
      ],
    );
    const loadedChat = mapChat(raw);
    const { store, tree } = await render({ loadedChat });
    expect(reasoningCards(tree)).toHaveLength(1);

    // The same reasoning identity streams to completion and then the answer lands. A
    // partial-to-completed update must grow the card it already owns, never add a second.
    act(() => {
      store.set(liveAssistantByThreadAtom, {
        child: {
          ...createAgUiThreadMessageState(),
          messages: [
            {
              id: 'msg_answer::thought',
              role: 'reasoning',
              content: REASONING,
              createdAt: '2026-07-20T00:00:04.000Z',
            },
            {
              id: 'msg_answer::agent',
              role: 'assistant',
              content: ANSWER,
              createdAt: '2026-07-20T00:00:05.000Z',
            },
          ],
        },
      });
    });

    expect(reasoningCards(tree)).toHaveLength(1);
    expect(renderedText(tree)).toContain(REASONING);
    expect(chronologicalOrder(tree, [PROMPT, REASONING, ANSWER])).toEqual([
      PROMPT,
      REASONING,
      ANSWER,
    ]);
    act(() => tree.unmount());
  });

  it('keeps two genuine reasoning turns as two cards', async () => {
    const raw = snapshotThread(
      [
        { sequence: 0, kind: 'reasoning', canonicalId: 'msg_answer::thought' },
        { sequence: 1, kind: 'message', canonicalId: 'msg_answer::agent' },
        { sequence: 2, kind: 'reasoning', canonicalId: 'msg_followup::thought' },
      ],
      [
        { id: 'msg_answer::thought', role: 'thought', text: REASONING },
        { id: 'msg_answer::agent', role: 'agent', text: ANSWER },
        { id: 'msg_followup::thought', role: 'thought', text: 'Now verifying the result.' },
      ],
    );
    const { tree } = await render({ loadedChat: mapChat(raw) });

    expect(reasoningCards(tree)).toHaveLength(2);
    expect(chronologicalOrder(tree, [REASONING, ANSWER, 'Now verifying the result.'])).toEqual([
      REASONING,
      ANSWER,
      'Now verifying the result.',
    ]);
    act(() => tree.unmount());
  });
});
