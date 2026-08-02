import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { createElement } from 'react';
import type { HostBridgeApiClient } from '../api/client';
import type { HostBridgeWsClient } from '../api/ws';
import type { PendingApproval, PendingUserInputRequest, RpcNotification } from '../api/types';
import { useDrawerAttentionRequests } from './useDrawerAttentionRequests';

function approval(threadId: string): PendingApproval {
  return {
    requestId: `approval-${threadId}`,
    agentId: 'codex',
    kind: 'command',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    title: 'Approval requested',
    message: 'Approve this command.',
    requestedAt: '2026-07-20T00:25:00.000Z',
    options: [{ id: 'accept', label: 'Accept' }],
  };
}

function userInput(threadId: string): PendingUserInputRequest {
  return {
    requestId: `input-${threadId}`,
    agentId: 'copilot',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    message: 'Input requested.',
    requestedAt: '2026-07-20T00:26:00.000Z',
    questions: [],
  };
}

interface Harness {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  emitEvent: (event: RpcNotification) => void;
  emitStatus: (connected: boolean) => void;
  listApprovals: jest.Mock;
  listPendingUserInputs: jest.Mock;
}

function createHarness({
  approvalFailure = false,
  userInputFailure = false,
}: { approvalFailure?: boolean; userInputFailure?: boolean } = {}): Harness {
  const eventHandlers = new Set<(event: RpcNotification) => void>();
  const statusHandlers = new Set<(connected: boolean) => void>();
  const listApprovals = approvalFailure
    ? jest.fn().mockRejectedValue(new Error('approval list failed'))
    : jest.fn().mockResolvedValue([]);
  const listPendingUserInputs = userInputFailure
    ? jest.fn().mockRejectedValue(new Error('user input list failed'))
    : jest.fn().mockResolvedValue([]);
  const api = { listApprovals, listPendingUserInputs } as unknown as HostBridgeApiClient;
  const ws = {
    onEvent: jest.fn().mockImplementation((handler) => {
      eventHandlers.add(handler);
      return jest.fn(() => eventHandlers.delete(handler));
    }),
    onStatus: jest.fn().mockImplementation((handler) => {
      statusHandlers.add(handler);
      return jest.fn(() => statusHandlers.delete(handler));
    }),
  } as unknown as HostBridgeWsClient;
  return {
    api,
    ws,
    emitEvent: (event) => eventHandlers.forEach((handler) => handler(event)),
    emitStatus: (connected) => statusHandlers.forEach((handler) => handler(connected)),
    listApprovals,
    listPendingUserInputs,
  };
}

type HookResult = ReturnType<typeof useDrawerAttentionRequests>;

function renderAttentionRequests(
  harness: Harness,
  active = true,
): { tree: ReactTestRenderer; latest: () => HookResult; rerender: (nextActive: boolean) => void } {
  let latestResult!: HookResult;
  function Probe({ activeProp }: { activeProp: boolean }) {
    latestResult = useDrawerAttentionRequests(harness.api, harness.ws, activeProp);
    return null;
  }
  let tree!: ReactTestRenderer;
  act(() => {
    tree = renderer.create(createElement(Probe, { activeProp: active }));
  });
  return {
    tree,
    latest: () => latestResult,
    rerender: (nextActive: boolean) => {
      act(() => {
        tree.update(createElement(Probe, { activeProp: nextActive }));
      });
    },
  };
}

describe('useDrawerAttentionRequests event burst debouncing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces a burst of approval/user-input events into a single trailing refresh', async () => {
    const harness = createHarness();
    harness.listApprovals.mockResolvedValueOnce([]).mockResolvedValueOnce([approval('a')]);
    harness.listPendingUserInputs.mockResolvedValueOnce([]).mockResolvedValueOnce([userInput('b')]);
    const { tree, latest } = renderAttentionRequests(harness);

    // The initial mount refresh fires immediately.
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.listApprovals).toHaveBeenCalledTimes(1);

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'a' } });
      harness.emitEvent({ method: 'bridge/approval.resolved', params: { threadId: 'a' } });
      harness.emitEvent({ method: 'bridge/userInput.requested', params: { threadId: 'b' } });
      harness.emitEvent({ method: 'bridge/userInput.resolved', params: { threadId: 'b' } });
      // Bursts arriving before the debounce window elapses should not add more fetches.
      jest.advanceTimersByTime(100);
      await Promise.resolve();
    });
    expect(harness.listApprovals).toHaveBeenCalledTimes(1);
    expect(latest().pendingApprovals).toEqual([]);

    await act(async () => {
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });
    // The whole burst collapses into exactly one additional refresh.
    expect(harness.listApprovals).toHaveBeenCalledTimes(2);
    expect(harness.listPendingUserInputs).toHaveBeenCalledTimes(2);
    expect(latest().pendingApprovals).toEqual([approval('a')]);
    expect(latest().pendingUserInputs).toEqual([userInput('b')]);
    expect(latest().attentionRequestError).toBeNull();

    act(() => tree.unmount());
  });

  it('still refreshes promptly for a lone event', async () => {
    const harness = createHarness();
    const { tree } = renderAttentionRequests(harness);

    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.listApprovals).toHaveBeenCalledTimes(1);

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'a' } });
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.listApprovals).toHaveBeenCalledTimes(2);
    act(() => tree.unmount());
  });

  it('preserves error reporting behavior for a debounced burst refresh', async () => {
    const harness = createHarness({ approvalFailure: true });
    const { latest, tree } = renderAttentionRequests(harness);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest().attentionRequestError).toBe('Could not refresh pending approvals.');

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'a' } });
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'a' } });
      jest.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.listApprovals).toHaveBeenCalledTimes(2);
    expect(latest().attentionRequestError).toBe('Could not refresh pending approvals.');
    act(() => tree.unmount());
  });

  it('cancels a pending debounced refresh when the drawer goes inactive before it fires', async () => {
    const harness = createHarness();
    const { tree, rerender } = renderAttentionRequests(harness);

    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.listApprovals).toHaveBeenCalledTimes(1);

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'a' } });
      await Promise.resolve();
    });

    rerender(false);

    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
    });

    // Going inactive cancels the scheduled refresh instead of letting it fire later.
    expect(harness.listApprovals).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('cancels a pending debounced refresh on unmount without further state updates', async () => {
    const harness = createHarness();
    const { tree } = renderAttentionRequests(harness);

    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.listApprovals).toHaveBeenCalledTimes(1);

    await act(async () => {
      harness.emitEvent({ method: 'bridge/approval.requested', params: { threadId: 'a' } });
      await Promise.resolve();
    });

    act(() => tree.unmount());

    await act(async () => {
      jest.advanceTimersByTime(500);
      await Promise.resolve();
    });

    // Unmounting clears the scheduled timer, so no fetch fires after teardown.
    expect(harness.listApprovals).toHaveBeenCalledTimes(1);
  });
});
