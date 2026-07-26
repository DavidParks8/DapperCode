import {
  resolveDisplayedActivity,
  resolveVisibleActivity,
  type ActivityIndicatorInputs,
} from './mainScreenActivityIndicator';
import type { ActivityState } from './mainScreenHelpers';

const READY: ActivityState = { tone: 'idle', title: 'Ready' };

function inputs(overrides: Partial<ActivityIndicatorInputs> = {}): ActivityIndicatorInputs {
  return {
    activity: READY,
    heldActivity: null,
    isConnected: true,
    isLoading: false,
    isOpeningChat: false,
    isTurnLikelyRunning: false,
    pendingApproval: null,
    pendingUserInputRequest: null,
    selectedChatStatus: 'idle',
    showBridgeRecoveryBanner: false,
    turnFailureDetail: null,
    ...overrides,
  };
}

/**
 * The header indicator is the one piece of UI on screen at every step of every
 * scenario, so it gets asserted step by step rather than only at rest.
 */
describe('activity indicator', () => {
  it('reports each step of an ordinary turn', () => {
    const steps: Array<[string, Partial<ActivityIndicatorInputs>, ActivityState]> = [
      ['at rest', {}, READY],
      ['opening a chat', { isOpeningChat: true }, { tone: 'running', title: 'Opening chat' }],
      [
        'sending',
        { isLoading: true },
        { tone: 'running', title: 'Working', detail: undefined },
      ],
      [
        'running with a detailed status',
        {
          isTurnLikelyRunning: true,
          activity: { tone: 'running', title: 'Editing src/math.ts', detail: 'write' },
        },
        { tone: 'running', title: 'Editing src/math.ts', detail: 'write' },
      ],
      [
        'complete',
        { selectedChatStatus: 'complete' },
        { tone: 'complete', title: 'Turn completed' },
      ],
    ];

    steps.forEach(([label, overrides, expected]) => {
      expect([label, resolveVisibleActivity(inputs(overrides))]).toEqual([label, expected]);
    });
  });

  it('never shows a settled title next to a running spinner', () => {
    // A sub-agent can keep the turn running after the parent's own activity has
    // settled to "Ready". Showing "Ready" with a spinner reads as a stuck UI.
    for (const settled of [READY, { tone: 'complete', title: 'Turn completed' }] as const) {
      const result = resolveVisibleActivity(inputs({ activity: settled, isTurnLikelyRunning: true }));
      expect(result).toEqual({ tone: 'running', title: 'Working', detail: undefined });
    }
  });

  it('reports work in progress even when the chat itself reads complete', () => {
    // isTurnLikelyRunning folds in sub-agent state, so a parent whose own run has
    // finished still reports working while a sub-agent is going.
    expect(
      resolveVisibleActivity(inputs({ selectedChatStatus: 'complete', isTurnLikelyRunning: true })),
    ).toEqual({ tone: 'running', title: 'Working', detail: undefined });
  });

  it('prefers waiting states over running ones', () => {
    // A turn is still "running" while it waits on the user, but the actionable
    // status is what it is waiting for.
    expect(
      resolveVisibleActivity(
        inputs({ isTurnLikelyRunning: true, pendingApproval: { kind: 'commandExecution' } }),
      ),
    ).toEqual({ tone: 'idle', title: 'Waiting for approval', detail: 'Run command' });
    expect(
      resolveVisibleActivity(
        inputs({ isTurnLikelyRunning: true, pendingApproval: { command: 'npm test' } }),
      ),
    ).toEqual({ tone: 'idle', title: 'Waiting for approval', detail: 'npm test' });
    expect(
      resolveVisibleActivity(inputs({ isTurnLikelyRunning: true, pendingApproval: {} })),
    ).toEqual({ tone: 'idle', title: 'Waiting for approval', detail: 'File change' });
    expect(
      resolveVisibleActivity(inputs({ isTurnLikelyRunning: true, pendingUserInputRequest: {} })),
    ).toEqual({ tone: 'idle', title: 'Waiting for input' });
    expect(resolveVisibleActivity(inputs({ isOpeningChat: true, pendingApproval: {} }))).toEqual({
      tone: 'running',
      title: 'Opening chat',
    });
  });

  it('holds a detailed status only once the turn has stopped', () => {
    const held: ActivityState = { tone: 'running', title: 'Ran npm test', detail: 'exit 0' };
    expect(resolveVisibleActivity(inputs({ heldActivity: held }))).toEqual(held);
    expect(
      resolveVisibleActivity(inputs({ heldActivity: held, isTurnLikelyRunning: true })),
    ).toEqual({ tone: 'running', title: 'Working', detail: undefined });
    expect(resolveVisibleActivity(inputs({ heldActivity: held, isLoading: true }))).toEqual({
      tone: 'running',
      title: 'Working',
      detail: undefined,
    });
  });

  it('surfaces errors and keeps their detail', () => {
    const bridgeError: ActivityState = { tone: 'error', title: 'Bridge unreachable' };
    expect(resolveVisibleActivity(inputs({ activity: bridgeError }))).toEqual(bridgeError);
    // A non-"Turn failed" error outranks running, so a real failure is not buried.
    expect(
      resolveVisibleActivity(inputs({ activity: bridgeError, isTurnLikelyRunning: true })),
    ).toEqual(bridgeError);
    expect(
      resolveVisibleActivity(
        inputs({
          activity: { tone: 'error', title: 'Turn failed' },
          turnFailureDetail: 'agent exited 1',
        }),
      ),
    ).toEqual({ tone: 'error', title: 'Turn failed', detail: 'agent exited 1' });
  });

  it('reports the bridge as disconnected only once the banner is up', () => {
    // The override applies only to a status that is itself about the connection --
    // it must not overwrite a real status just because the socket dropped.
    const disconnected = {
      isConnected: false,
      activity: { tone: 'error', title: 'Disconnected' } as ActivityState,
    };
    expect(resolveDisplayedActivity(inputs(disconnected))).toEqual(READY);
    expect(
      resolveDisplayedActivity(inputs({ ...disconnected, showBridgeRecoveryBanner: true })),
    ).toEqual({
      tone: 'error',
      title: 'Bridge disconnected',
      detail: 'Start the bridge on your computer to continue.',
    });
    // A live turn is not a bridge recovery state, so it survives a dropped socket.
    expect(
      resolveDisplayedActivity(
        inputs({
          isConnected: false,
          showBridgeRecoveryBanner: true,
          isTurnLikelyRunning: true,
          activity: { tone: 'running', title: 'Editing src/math.ts' },
        }),
      ),
    ).toEqual({ tone: 'running', title: 'Editing src/math.ts', detail: undefined });
    // Connected, the override never applies.
    expect(resolveDisplayedActivity(inputs({ ...disconnected, isConnected: true }))).toEqual(
      disconnected.activity,
    );
  });
});
