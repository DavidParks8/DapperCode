import type { BridgeUiSurface, ChatSummary } from '@bridge/types/types';
import { resolveBridgeUiSurfaceBuckets } from './queueState';

function surface(id: string, overrides: Partial<BridgeUiSurface>): BridgeUiSurface {
  return {
    id,
    threadId: 'thread-1',
    presentation: 'workflowCard',
    title: id,
    blocks: [],
    actions: [],
    ...overrides,
  };
}

describe('resolveBridgeUiSurfaceBuckets', () => {
  it('docks live calls above the composer instead of pinning them under the header', () => {
    const call = surface('phone-call-live:1', { kind: 'phone-call' });
    const approval = surface('phone-call-approval:1', {
      kind: 'phone-call',
      presentation: 'modal',
    });
    const goal = surface('goal-1', { kind: 'goal' });
    const otherThread = surface('phone-call-live:2', { kind: 'phone-call', threadId: 'thread-2' });

    const buckets = resolveBridgeUiSurfaceBuckets({ id: 'thread-1' } as ChatSummary, [
      call,
      approval,
      goal,
      otherThread,
    ]);

    expect(buckets.callBridgeUiSurfaces).toEqual([call]);
    expect(buckets.workflowBridgeUiSurfaces).toEqual([goal]);
    expect(buckets.modalBridgeUiSurface).toBe(approval);
    expect(buckets.selectedBridgeUiSurfaces).toEqual([call, approval, goal]);
  });

  it('docks only the newest call result and marks earlier results as superseded', () => {
    const first = surface('phone-call-live:a', {
      kind: 'phone-call',
      createdAt: '2026-11-14T08:00:00Z',
    });
    const second = surface('phone-call-live:b', {
      kind: 'phone-call',
      createdAt: '2026-11-14T09:00:00Z',
    });

    const buckets = resolveBridgeUiSurfaceBuckets({ id: 'thread-1' } as ChatSummary, [
      first,
      second,
    ]);

    expect(buckets.callBridgeUiSurfaces).toEqual([second]);
    expect(buckets.supersededCallBridgeUiSurfaces).toEqual([first]);
  });
});
