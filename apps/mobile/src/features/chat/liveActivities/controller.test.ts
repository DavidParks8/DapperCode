import {
  AgentTurnActivityController,
  TERMINAL_ACTIVITY_LINGER_MS,
  deriveAgentTurnActivityTarget,
  type AgentTurnActivityTarget,
} from './controller';
import type {
  AgentTurnActivityAdapter,
  AgentTurnActivityDismissal,
  AgentTurnActivityHandle,
  AgentTurnActivityProps,
} from './types';
import { createAgentTurnActivityUrl } from './url';

interface RecordedHandle extends AgentTurnActivityHandle {
  updates: AgentTurnActivityProps[];
  endings: Array<{
    dismissal: AgentTurnActivityDismissal;
    props?: AgentTurnActivityProps;
  }>;
}

function createHandle(): RecordedHandle {
  const updates: AgentTurnActivityProps[] = [];
  const endings: RecordedHandle['endings'] = [];
  return {
    updates,
    endings,
    async update(props) {
      updates.push(props);
    },
    async end(dismissal, props) {
      endings.push({ dismissal, props });
    },
  };
}

function createAdapter(options?: {
  supported?: boolean;
  staleInstances?: RecordedHandle[];
}): AgentTurnActivityAdapter & {
  starts: Array<{ props: AgentTurnActivityProps; url: string; handle: RecordedHandle }>;
  getInstancesCalls: number;
} {
  const starts: Array<{
    props: AgentTurnActivityProps;
    url: string;
    handle: RecordedHandle;
  }> = [];
  const staleInstances = options?.staleInstances ?? [];
  return {
    supported: options?.supported ?? true,
    starts,
    getInstancesCalls: 0,
    async getInstances() {
      this.getInstancesCalls += 1;
      return staleInstances;
    },
    start(props, url) {
      const handle = createHandle();
      starts.push({ props, url, handle });
      return handle;
    },
  };
}

function activeTarget(
  overrides: Partial<Extract<AgentTurnActivityTarget, { kind: 'active' }>> = {},
): Extract<AgentTurnActivityTarget, { kind: 'active' }> {
  return {
    kind: 'active',
    profileId: 'profile-1',
    threadId: 'thread-1',
    runId: 'run-1',
    phase: 'working',
    url: 'dappercode://profiles/profile-1/chats/thread-1',
    ...overrides,
  };
}

function requireStart(
  adapter: ReturnType<typeof createAdapter>,
  index = 0,
): (typeof adapter.starts)[number] {
  const start = adapter.starts[index];
  if (!start) {
    throw new Error(`Expected Live Activity start at index ${index}.`);
  }
  return start;
}

describe('deriveAgentTurnActivityTarget', () => {
  const base = {
    profileId: 'profile-1',
    threadId: 'thread-1',
    activeTurnId: 'run-1',
    activity: { tone: 'running', title: 'Working', detail: 'private command' } as const,
    hasPendingApproval: false,
    hasPendingUserInput: false,
    url: 'dappercode://profiles/profile-1/chats/thread-1',
  };

  it('maps selected turn state to privacy-safe generic phases', () => {
    expect(deriveAgentTurnActivityTarget(base)).toEqual(activeTarget());
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        activity: { tone: 'running', title: 'Planning private implementation' },
      }),
    ).toEqual(activeTarget({ phase: 'planning' }));
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        hasPendingApproval: true,
      }),
    ).toEqual(activeTarget({ phase: 'waiting' }));
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        hasPendingUserInput: true,
      }),
    ).toEqual(activeTarget({ phase: 'waiting' }));
  });

  it('maps completion, failure, and cancellation without publishing private detail', () => {
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        activeTurnId: null,
        activity: { tone: 'complete', title: 'Turn completed' },
      }),
    ).toEqual({ kind: 'terminal', threadId: 'thread-1', phase: 'completed' });
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        activeTurnId: null,
        activity: { tone: 'complete', title: 'Turn stopped' },
      }),
    ).toEqual({ kind: 'terminal', threadId: 'thread-1', phase: 'stopped' });
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        activeTurnId: null,
        activity: { tone: 'error', title: 'Turn failed', detail: 'secret failure' },
      }),
    ).toEqual({ kind: 'terminal', threadId: 'thread-1', phase: 'failed' });
  });

  it('retains the current activity while run identity settles before a terminal state', () => {
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        activeTurnId: null,
        activity: { tone: 'running', title: 'Working' },
      }),
    ).toEqual({ kind: 'retain', threadId: 'thread-1' });
  });

  it('stays inactive without a selected runnable chat', () => {
    expect(deriveAgentTurnActivityTarget({ ...base, threadId: null })).toEqual({
      kind: 'inactive',
      threadId: null,
    });
    expect(deriveAgentTurnActivityTarget({ ...base, profileId: '' })).toEqual({
      kind: 'inactive',
      threadId: 'thread-1',
    });
    expect(
      deriveAgentTurnActivityTarget({
        ...base,
        activeTurnId: null,
        activity: { tone: 'idle', title: 'Ready' },
      }),
    ).toEqual({ kind: 'inactive', threadId: 'thread-1' });
  });

  it('creates an encoded app deep link for the selected chat', () => {
    expect(createAgentTurnActivityUrl('profile / one', 'thread?#1')).toBe(
      'dappercode:///profiles/profile%20%2F%20one/chats/thread%3F%231',
    );
  });
});

describe('AgentTurnActivityController', () => {
  let now = 1_000;

  beforeEach(() => {
    now = 1_000;
  });

  it('clears stale activities, starts once, and updates only meaningful phases', async () => {
    const stale = createHandle();
    const adapter = createAdapter({ staleInstances: [stale] });
    const controller = new AgentTurnActivityController(adapter, () => now);

    await controller.sync(activeTarget());
    expect(stale.endings).toEqual([{ dismissal: { kind: 'immediate' }, props: undefined }]);
    expect(adapter.starts).toHaveLength(1);
    const start = requireStart(adapter);
    expect(start).toMatchObject({
      props: {
        phase: 'working',
        startedAtEpochMs: 1_000,
        updatedAtEpochMs: 1_000,
      },
      url: activeTarget().url,
    });

    now = 2_000;
    await controller.sync(activeTarget());
    expect(start.handle.updates).toEqual([]);

    await controller.sync(activeTarget({ phase: 'planning' }));
    expect(start.handle.updates).toEqual([
      {
        phase: 'planning',
        startedAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
      },
    ]);

    now = 3_000;
    await controller.sync(activeTarget({ phase: 'waiting' }));
    expect(start.handle.updates.at(-1)).toEqual({
      phase: 'waiting',
      startedAtEpochMs: 1_000,
      updatedAtEpochMs: 3_000,
    });
  });

  it('shows a terminal state for one minute before dismissal', async () => {
    const adapter = createAdapter();
    const controller = new AgentTurnActivityController(adapter, () => now);
    await controller.sync(activeTarget());

    now = 5_000;
    await controller.sync({ kind: 'terminal', threadId: 'thread-1', phase: 'completed' });

    expect(requireStart(adapter).handle.endings).toEqual([
      {
        dismissal: {
          kind: 'after',
          date: new Date(5_000 + TERMINAL_ACTIVITY_LINGER_MS),
        },
        props: {
          phase: 'completed',
          startedAtEpochMs: 1_000,
          updatedAtEpochMs: 5_000,
        },
      },
    ]);
  });

  it('does not dismiss between clearing the run id and receiving its terminal state', async () => {
    const adapter = createAdapter();
    const controller = new AgentTurnActivityController(adapter, () => now);
    await controller.sync(activeTarget());
    const handle = requireStart(adapter).handle;

    await controller.sync({ kind: 'retain', threadId: 'thread-1' });
    expect(handle.endings).toEqual([]);

    now = 5_000;
    await controller.sync({ kind: 'terminal', threadId: 'thread-1', phase: 'stopped' });
    expect(handle.endings).toEqual([
      expect.objectContaining({
        dismissal: expect.objectContaining({ kind: 'after' }),
        props: expect.objectContaining({ phase: 'stopped' }),
      }),
    ]);
  });

  it('dismisses a lingering result before publishing the next turn', async () => {
    const adapter = createAdapter();
    const controller = new AgentTurnActivityController(adapter, () => now);
    await controller.sync(activeTarget());
    const firstHandle = requireStart(adapter).handle;

    now = 5_000;
    await controller.sync({ kind: 'terminal', threadId: 'thread-1', phase: 'completed' });
    now = 10_000;
    await controller.sync(activeTarget({ runId: 'run-2' }));

    expect(firstHandle.endings).toEqual([
      expect.objectContaining({
        dismissal: expect.objectContaining({ kind: 'after' }),
      }),
      { dismissal: { kind: 'immediate' }, props: undefined },
    ]);
    expect(adapter.starts).toHaveLength(2);
  });

  it('retires the old selected turn before starting a newly selected turn', async () => {
    const adapter = createAdapter();
    const controller = new AgentTurnActivityController(adapter, () => now);
    await controller.sync(activeTarget());

    now = 2_000;
    await controller.sync(
      activeTarget({
        threadId: 'thread-2',
        runId: 'run-2',
        url: 'dappercode://profiles/profile-1/chats/thread-2',
      }),
    );

    expect(adapter.starts).toHaveLength(2);
    expect(requireStart(adapter).handle.endings).toEqual([
      { dismissal: { kind: 'immediate' }, props: undefined },
    ]);
    expect(requireStart(adapter, 1).props.startedAtEpochMs).toBe(2_000);
  });

  it('serializes a delayed update before ending so stale work cannot touch a newer run', async () => {
    let releaseUpdate: (() => void) | null = null;
    const adapter = createAdapter();
    const controller = new AgentTurnActivityController(adapter, () => now);
    await controller.sync(activeTarget());
    const firstHandle = requireStart(adapter).handle;
    firstHandle.update = async (props) => {
      await new Promise<void>((resolve) => {
        releaseUpdate = resolve;
      });
      firstHandle.updates.push(props);
    };

    const planning = controller.sync(activeTarget({ phase: 'planning' }));
    const switched = controller.sync(
      activeTarget({
        threadId: 'thread-2',
        runId: 'run-2',
        url: 'dappercode://profiles/profile-1/chats/thread-2',
      }),
    );
    for (let index = 0; index < 10 && !releaseUpdate; index += 1) {
      await Promise.resolve();
    }
    expect(adapter.starts).toHaveLength(1);

    const release = releaseUpdate as (() => void) | null;
    expect(release).not.toBeNull();
    release?.();
    await planning;
    await switched;

    expect(firstHandle.endings).toEqual([{ dismissal: { kind: 'immediate' }, props: undefined }]);
    expect(adapter.starts).toHaveLength(2);
  });

  it('reconciles native instances and restarts the desired selected turn', async () => {
    const nativeInstance = createHandle();
    const adapter = createAdapter({ staleInstances: [nativeInstance] });
    const controller = new AgentTurnActivityController(adapter, () => now);
    await controller.sync(activeTarget());
    expect(adapter.starts).toHaveLength(1);

    now = 2_000;
    await controller.reconcile();

    expect(nativeInstance.endings).toHaveLength(2);
    expect(requireStart(adapter).handle.endings).toEqual([]);
    expect(adapter.starts).toHaveLength(2);
    expect(requireStart(adapter, 1).props.startedAtEpochMs).toBe(2_000);
  });

  it('does nothing on unsupported platforms and reports native failures', async () => {
    const unsupported = createAdapter({ supported: false });
    const unsupportedController = new AgentTurnActivityController(unsupported);
    await unsupportedController.sync(activeTarget());
    expect(unsupported.getInstancesCalls).toBe(0);
    expect(unsupported.starts).toEqual([]);

    const errors: Error[] = [];
    const failing = createAdapter();
    failing.getInstances = async () => {
      throw new Error('ActivityKit disabled');
    };
    const controller = new AgentTurnActivityController(failing, Date.now, (error) => {
      errors.push(error);
    });
    await controller.sync(activeTarget());
    expect(errors).toEqual([new Error('ActivityKit disabled')]);
    expect(failing.starts).toEqual([]);
  });
});
