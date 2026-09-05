import { act, renderHook } from '@testing-library/react-native';
import type { SnapshotPageResponse } from '@bridge/client/client';
import { applySnapshotToChat, type RawAcpSnapshot } from '@bridge/mapping/chatMapping';
import type { Chat } from '@bridge/types/types';
import { isChatLikelyRunning } from '../helpers/helpers';
import { resolveEquivalentChat } from '../state/chatReconciliation';
import {
  getTranscriptContinuationState,
  TranscriptContinuationController,
  type TranscriptContinuationState,
} from '../transcript/controllers/continuationController';
import { useMainScreenChatNavigation } from './chatNavigation';

jest.mock('expo-router', () => ({
  useRouter: () => ({}),
  useLocalSearchParams: () => ({ profileId: 'profile', chatId: 'thread' }),
}));

const date = '2026-09-04T12:00:00.000Z';

function chat(id = 'thread', revision = 3): Chat {
  const snapshot: RawAcpSnapshot = {
    version: 2,
    timeline: [{ sequence: 2, kind: 'message', canonicalId: 'answer' }],
    messages: [
      {
        id: 'answer',
        role: 'agent',
        parts: [{ type: 'text', text: 'Partial answer' }],
        truncated: false,
      },
    ],
    tools: [],
    messageCollection: { truncated: true, omittedCount: 1, beforeCursor: 'before-2', revision },
    continuation: {
      revision,
      unavailableCount: 0,
      maxPageSize: 50,
      maxHistoryEntries: 1024,
      maxHistoryBytes: 4194304,
    },
    plan: [],
    usage: {},
    config: [],
    commands: [],
    session: { agentId: 'fixture', threadId: id, historyReconstruction: false },
    active: { runId: 'running-turn', toolIds: [] },
  };
  return {
    ...applySnapshotToChat(
      {
        id,
        title: id,
        status: 'running',
        createdAt: date,
        updatedAt: date,
        statusUpdatedAt: date,
        lastMessagePreview: 'Partial answer',
        messages: [],
      },
      snapshot,
    ),
    activeTurnId: 'running-turn',
  };
}

function finalChat(initial: Chat): Chat {
  return {
    ...initial,
    status: 'complete',
    latestTurnStatus: 'complete',
    activeTurnId: null,
    acpActive: { runId: null, sourceTurnId: null, generation: null, toolIds: [] },
    lastMessagePreview: 'Final answer',
    messages: [{ id: 'answer', role: 'assistant', content: 'Final answer', createdAt: date }],
  };
}

function page(revision = 3): SnapshotPageResponse {
  return {
    entries: [
      {
        sequence: 1,
        kind: 'message',
        canonicalId: 'earlier',
        message: {
          id: 'earlier',
          role: 'user',
          parts: [{ type: 'text', text: 'Earlier question' }],
          truncated: false,
        },
      },
    ],
    beforeCursor: null,
    afterCursor: null,
    hasMoreBefore: false,
    hasMoreAfter: true,
    unavailableCount: 0,
    earliestAvailableSequence: 1,
    latestAvailableSequence: 2,
    revision,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup(initial = chat()) {
  const pages: ReturnType<typeof deferred<SnapshotPageResponse>>[] = [];
  const readSnapshotPage = jest.fn(() => {
    const pending = deferred<SnapshotPageResponse>();
    pages.push(pending);
    return pending.promise;
  });
  const selectedChatRef = { current: initial as Chat | null };
  const selectedChatIdRef = { current: initial.id as string | null };
  const continuation = { current: getTranscriptContinuationState(initial) };
  const rememberChat = jest.fn();
  const setSelectedChat = jest.fn(
    (update: Chat | null | ((previous: Chat | null) => Chat | null)) => {
      selectedChatRef.current =
        typeof update === 'function' ? update(selectedChatRef.current) : update;
    },
  );
  const setTranscriptContinuationState = jest.fn(
    (
      update:
        | TranscriptContinuationState
        | ((previous: TranscriptContinuationState) => TranscriptContinuationState),
    ) => {
      continuation.current = typeof update === 'function' ? update(continuation.current) : update;
    },
  );
  const context = {
    api: { rememberChat, peekChat: jest.fn(() => null), peekChatShell: jest.fn(() => null) },
    attachmentController: { closePathModal: jest.fn() },
    selectedChatRef,
    selectedChatIdRef,
    chatIdRef: selectedChatIdRef,
    autoEnabledPlanTurnIdByThreadRef: { current: {} },
    openingChatStartedAtRef: { current: 0 },
    stopRequestedRef: { current: false },
    stopSystemMessageLoggedRef: { current: false },
    applyThreadRuntimeSnapshot: jest.fn(),
    refreshPendingApprovalsForThread: jest.fn(async () => undefined),
    setOpeningChatId: jest.fn(),
    setSelectedChatId: (id: string) => {
      selectedChatIdRef.current = id;
    },
    mergeChatWithPendingOptimisticMessages: (value: Chat) => value,
    loadChat: jest.fn(async () => true),
    setSelectedChat,
    setTranscriptContinuationState,
    transcriptContinuationController: new TranscriptContinuationController({ readSnapshotPage }),
    get transcriptContinuationState() {
      return continuation.current;
    },
  };
  const hook = renderHook(() => useMainScreenChatNavigation(context as never));
  const load = () => {
    let request!: Promise<void>;
    act(() => {
      request = hook.result.current.handleLoadEarlier();
    });
    return request;
  };
  const select = (next: Chat) => {
    act(() => {
      hook.result.current.openChatThread(next.id, next);
    });
    hook.rerender({});
  };
  return { ...hook, context, continuation, pages, readSnapshotPage, load, select };
}

function expectSettled(current: Chat | null) {
  expect(current).toMatchObject({
    status: 'complete',
    latestTurnStatus: 'complete',
    activeTurnId: null,
    acpActive: { runId: null, toolIds: [] },
    lastMessagePreview: 'Final answer',
  });
  expect(isChatLikelyRunning(current!)).toBe(false);
  expect(current?.messages.find(({ id }) => id === 'answer')?.content).toBe('Final answer');
}

describe('older history request lifecycle', () => {
  it('retries the current snapshot rather than paginating when history recovery failed', async () => {
    const harness = setup({ ...chat(), historyRecoveryError: 'History unavailable' });
    await act(async () => {
      await harness.load();
    });
    expect(harness.context.loadChat).toHaveBeenCalledWith('thread', {
      preserveRuntimeState: true,
      revalidate: true,
    });
    expect(harness.readSnapshotPage).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('keeps the completed response and settled controls when a running-turn page arrives late', async () => {
    const harness = setup();
    expect(isChatLikelyRunning(harness.context.selectedChatRef.current!)).toBe(true);
    const pending = harness.load();
    expect(harness.continuation.current.loading).toBe(true);
    harness.context.selectedChatRef.current = finalChat(harness.context.selectedChatRef.current!);
    expectSettled(harness.context.selectedChatRef.current);

    await act(async () => {
      harness.pages[0]!.resolve(page());
      await pending;
    });

    expectSettled(harness.context.selectedChatRef.current);
    expect(harness.context.selectedChatRef.current?.messages.map(({ id }) => id)).toEqual([
      'earlier',
      'answer',
    ]);
    expect(harness.continuation.current).toMatchObject({
      loading: false,
      error: null,
      exhausted: true,
    });
    expect(harness.context.api.rememberChat).toHaveBeenCalledTimes(1);
    expect(harness.context.api.rememberChat).toHaveBeenCalledWith(
      harness.context.selectedChatRef.current,
    );
  });

  it('retains streaming additions and optimistic turns while adding legitimate history', async () => {
    const harness = setup();
    const pending = harness.load();
    const initial = harness.context.selectedChatRef.current!;
    harness.context.selectedChatRef.current = {
      ...initial,
      messages: [
        { id: 'kickoff', role: 'user', content: 'Recovered kickoff', createdAt: date },
        {
          id: 'answer',
          role: 'assistant',
          createdAt: date,
          content: 'A longer streamed answer',
        },
        { id: 'optimistic-user', role: 'user', content: 'Next question', createdAt: date },
      ],
      lastMessagePreview: 'Next question',
    };
    await act(async () => {
      harness.pages[0]!.resolve(page());
      await pending;
    });
    expect(harness.context.selectedChatRef.current?.messages.map(({ content }) => content)).toEqual(
      ['Recovered kickoff', 'Earlier question', 'A longer streamed answer', 'Next question'],
    );
    expect(harness.context.selectedChatRef.current?.activeTurnId).toBe('running-turn');
    expect(harness.context.selectedChatRef.current?.lastMessagePreview).toBe('Next question');
  });

  it('shows a retryable failure without reinstalling the captured running chat', async () => {
    const harness = setup();
    const pending = harness.load();
    const final = finalChat(harness.context.selectedChatRef.current!);
    harness.context.selectedChatRef.current = final;
    await act(async () => {
      harness.pages[0]!.reject(new Error('offline'));
      await pending;
    });
    expectSettled(harness.context.selectedChatRef.current);
    expect(harness.context.selectedChatRef.current).toBe(final);
    expect(harness.context.api.rememberChat).not.toHaveBeenCalled();
    expect(harness.continuation.current).toMatchObject({ loading: false, error: 'offline' });

    const retry = harness.load();
    expect(harness.continuation.current).toMatchObject({ loading: true, error: null });
    await act(async () => {
      harness.pages[1]!.resolve(page());
      await retry;
    });
    expectSettled(harness.context.selectedChatRef.current);
    expect(harness.continuation.current).toMatchObject({ loading: false, error: null });
  });

  it.each(['page', 'error', 'stale'] as const)(
    'ignores an old %s after A → B → A, including while the replacement request is pending',
    async (outcome) => {
      const harness = setup();
      const oldRequest = harness.load();
      harness.select(chat('other'));
      expect(harness.continuation.current).toMatchObject({ loading: false, error: null });
      harness.select(finalChat(chat()));
      const newRequest = harness.load();
      expect(harness.readSnapshotPage).toHaveBeenCalledTimes(2);
      await act(async () => {
        if (outcome === 'error') {
          harness.pages[0]!.reject(new Error('old request failed'));
        } else {
          harness.pages[0]!.resolve(page(outcome === 'stale' ? 4 : 3));
        }
        await oldRequest;
      });
      expectSettled(harness.context.selectedChatRef.current);
      expect(harness.context.api.rememberChat).not.toHaveBeenCalled();
      expect(harness.continuation.current).toMatchObject({ loading: true, error: null });
      expect(harness.context.loadChat).toHaveBeenCalledTimes(2);
      await act(async () => {
        harness.pages[1]!.resolve(page());
        await newRequest;
      });
      expectSettled(harness.context.selectedChatRef.current);
      expect(harness.continuation.current).toMatchObject({ loading: false, exhausted: true });
      expect(harness.context.api.rememberChat).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores a superseded snapshot revision and allows pagination from its new cursor', async () => {
    const harness = setup();
    const pending = harness.load();
    const final = finalChat(chat('thread', 4));
    harness.context.selectedChatRef.current = final;
    harness.continuation.current = getTranscriptContinuationState(final);
    await act(async () => {
      harness.pages[0]!.reject(new Error('obsolete cursor failed'));
      await pending;
    });
    expect(harness.context.selectedChatRef.current).toBe(final);
    expect(harness.continuation.current.error).toBeNull();
    expect(harness.context.api.rememberChat).not.toHaveBeenCalled();
    const retry = harness.load();
    await act(async () => {
      harness.pages[1]!.resolve(page(4));
      await retry;
    });
    expectSettled(harness.context.selectedChatRef.current);
    expect(harness.continuation.current.exhausted).toBe(true);
  });

  it('deduplicates taps before rerender and ignores a response after unmount', async () => {
    const harness = setup();
    const pending = harness.load();
    await harness.load();
    expect(harness.readSnapshotPage).toHaveBeenCalledTimes(1);
    expect(harness.context.setSelectedChat).not.toHaveBeenCalled();
    expect(harness.context.api.rememberChat).not.toHaveBeenCalled();
    harness.unmount();
    harness.context.setSelectedChat.mockClear();
    harness.context.setTranscriptContinuationState.mockClear();
    await act(async () => {
      harness.pages[0]!.resolve(page());
      await pending;
    });
    expect(harness.context.setSelectedChat).not.toHaveBeenCalled();
    expect(harness.context.setTranscriptContinuationState).not.toHaveBeenCalled();
    expect(harness.context.api.rememberChat).not.toHaveBeenCalled();
  });

  it('keeps a newer successful page when an old selection request fails afterward', async () => {
    const harness = setup();
    const oldRequest = harness.load();
    harness.select(chat('other'));
    harness.select(finalChat(chat()));
    const newRequest = harness.load();
    await act(async () => {
      harness.pages[1]!.resolve(page());
      await newRequest;
    });
    const accepted = harness.context.selectedChatRef.current;
    await act(async () => {
      harness.pages[0]!.reject(new Error('late obsolete failure'));
      await oldRequest;
    });
    expect(harness.context.selectedChatRef.current).toBe(accepted);
    expectSettled(accepted);
    expect(harness.continuation.current).toMatchObject({
      loading: false,
      error: null,
      exhausted: true,
    });
    expect(harness.context.api.rememberChat).toHaveBeenCalledTimes(1);
  });

  it('refetches a genuinely stale cursor without publishing an old snapshot', async () => {
    const harness = setup();
    const pending = harness.load();
    harness.context.selectedChatRef.current = finalChat(harness.context.selectedChatRef.current!);
    await act(async () => {
      harness.pages[0]!.resolve(page(4));
      await pending;
    });
    expectSettled(harness.context.selectedChatRef.current);
    expect(harness.context.api.rememberChat).not.toHaveBeenCalled();
    expect(harness.context.loadChat).toHaveBeenCalledWith('thread', { preserveRuntimeState: true });
    expect(harness.continuation.current).toMatchObject({
      loading: false,
      error: null,
      exhausted: false,
    });
  });

  it('fences an A → B → A navigation even when both opens happen before the next render', async () => {
    const harness = setup();
    const pending = harness.load();
    act(() => {
      harness.result.current.openChatThread('other', chat('other'));
      harness.result.current.openChatThread('thread', finalChat(chat()));
    });
    await act(async () => {
      harness.pages[0]!.resolve(page());
      await pending;
    });
    expectSettled(harness.context.selectedChatRef.current);
    expect(harness.context.api.rememberChat).not.toHaveBeenCalled();
    expect(harness.continuation.current).toMatchObject({ loading: false, exhausted: false });
  });

  it.each(['agent', 'user'] as const)(
    'does not materialize a newest canonical echo while paging an older %s message',
    async (role) => {
      const recovered = chat();
      recovered.messages = [
        { id: 'kickoff', role: 'user', content: 'Original question', createdAt: date },
        ...recovered.messages,
        { id: 'msg-optimistic', role: 'user', content: 'Follow-up question', createdAt: date },
      ];
      const echoedSnapshot: RawAcpSnapshot = {
        ...recovered.acpSnapshot!,
        timeline: [
          ...recovered.acpSnapshot!.timeline!,
          { sequence: 3, kind: 'message', canonicalId: 'canonical-followup' },
        ],
        messages: [
          ...recovered.acpSnapshot!.messages,
          {
            id: 'canonical-followup',
            role: 'user',
            parts: [{ type: 'text', text: 'Follow-up question' }],
            truncated: false,
          },
        ],
      };
      // A bounded echo without its response retains the visible optimistic turn until hydration.
      const current = resolveEquivalentChat(
        recovered,
        applySnapshotToChat(recovered, echoedSnapshot),
      );
      expect(current.messages.filter(({ role }) => role === 'user').map(({ id }) => id)).toEqual([
        'kickoff',
        'msg-optimistic',
      ]);
      const harness = setup(current);
      const pending = harness.load();
      const settled = {
        ...current,
        status: 'complete' as const,
        activeTurnId: null,
        messages: [
          ...current.messages,
          {
            id: 'followup-answer',
            role: 'assistant' as const,
            content: 'Follow-up completed',
            createdAt: date,
          },
        ],
      };
      harness.context.selectedChatRef.current = settled;
      const historicalPage = page();
      historicalPage.entries[0]!.message!.role = role;
      historicalPage.entries[0]!.message!.parts = [{ type: 'text', text: 'Follow-up question' }];
      await act(async () => {
        harness.pages[0]!.resolve(historicalPage);
        await pending;
      });
      expect(
        harness.context.selectedChatRef.current?.messages
          .filter(({ role }) => role === 'user')
          .map(({ id }) => id),
      ).toEqual(
        role === 'user' ? ['kickoff', 'earlier', 'msg-optimistic'] : ['kickoff', 'msg-optimistic'],
      );
      expect(harness.context.selectedChatRef.current?.messages.at(-1)?.id).toBe('followup-answer');
      expect(harness.context.selectedChatRef.current?.status).toBe('complete');
      expect(
        harness.context.selectedChatRef.current?.messages.some(({ id }) => id === 'earlier'),
      ).toBe(true);
    },
  );
});
