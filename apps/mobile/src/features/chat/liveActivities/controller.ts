import type { ActivityState } from '../state/runtime';
import type {
  AgentTurnActivityAdapter,
  AgentTurnActivityHandle,
  AgentTurnActivityPhase,
  AgentTurnActivityProps,
} from './types';

export const TERMINAL_ACTIVITY_LINGER_MS = 60_000;

export type AgentTurnActivityTarget =
  | {
      kind: 'active';
      profileId: string;
      threadId: string;
      runId: string;
      phase: 'working' | 'planning' | 'waiting';
      url: string;
    }
  | {
      kind: 'terminal';
      threadId: string;
      phase: 'completed' | 'failed' | 'stopped';
    }
  | { kind: 'retain'; threadId: string }
  | { kind: 'inactive'; threadId: string | null };

export interface AgentTurnActivityTargetInputs {
  profileId: string;
  threadId: string | null;
  activeTurnId: string | null;
  activity: ActivityState;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  url: string | null;
}

interface CurrentActivity {
  key: string;
  threadId: string;
  handle: AgentTurnActivityHandle;
  props: AgentTurnActivityProps;
}

interface LingeringActivity {
  threadId: string;
  handle: AgentTurnActivityHandle;
  dismissAtEpochMs: number;
}

export function deriveAgentTurnActivityTarget(
  inputs: AgentTurnActivityTargetInputs,
): AgentTurnActivityTarget {
  if (!inputs.threadId) {
    return { kind: 'inactive', threadId: null };
  }

  if (inputs.activeTurnId) {
    const normalizedTitle = inputs.activity.title.trim().toLowerCase();
    const phase =
      inputs.hasPendingApproval || inputs.hasPendingUserInput
        ? 'waiting'
        : normalizedTitle.includes('plan')
          ? 'planning'
          : 'working';
    if (!inputs.profileId || !inputs.url) {
      return { kind: 'inactive', threadId: inputs.threadId };
    }
    return {
      kind: 'active',
      profileId: inputs.profileId,
      threadId: inputs.threadId,
      runId: inputs.activeTurnId,
      phase,
      url: inputs.url,
    };
  }

  if (inputs.activity.tone === 'error') {
    return { kind: 'terminal', threadId: inputs.threadId, phase: 'failed' };
  }
  if (inputs.activity.tone === 'complete') {
    const stopped = inputs.activity.title.trim().toLowerCase().includes('stopped');
    return {
      kind: 'terminal',
      threadId: inputs.threadId,
      phase: stopped ? 'stopped' : 'completed',
    };
  }
  if (
    inputs.activity.tone === 'running' ||
    inputs.hasPendingApproval ||
    inputs.hasPendingUserInput
  ) {
    return { kind: 'retain', threadId: inputs.threadId };
  }
  return { kind: 'inactive', threadId: inputs.threadId };
}

export class AgentTurnActivityController {
  private current: CurrentActivity | null = null;
  private lingering: LingeringActivity | null = null;
  private desired: AgentTurnActivityTarget = { kind: 'inactive', threadId: null };
  private initialized = false;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: AgentTurnActivityAdapter,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: Error) => void = () => {},
  ) {}

  sync(target: AgentTurnActivityTarget): Promise<void> {
    this.desired = target;
    return this.enqueue(async () => {
      if (!this.adapter.supported || this.disposed) {
        return;
      }
      await this.initialize();
      await this.applyTarget(target);
    });
  }

  reconcile(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.adapter.supported || this.disposed) {
        return;
      }
      await this.clearLingering();
      const instances = await this.adapter.getInstances();
      await Promise.all(instances.map((instance) => instance.end({ kind: 'immediate' })));
      this.current = null;
      this.initialized = true;
      await this.applyTarget(this.desired);
    });
  }

  dispose(): Promise<void> {
    this.desired = { kind: 'inactive', threadId: null };
    return this.enqueue(async () => {
      this.disposed = true;
      if (!this.adapter.supported) {
        return;
      }
      await this.clearLingering();
      if (this.current) {
        await this.endCurrent({ kind: 'immediate' });
      }
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch((cause: unknown) => {
      this.onError(cause instanceof Error ? cause : new Error(String(cause)));
    });
    return this.queue;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const staleInstances = await this.adapter.getInstances();
    await Promise.all(staleInstances.map((instance) => instance.end({ kind: 'immediate' })));
    this.initialized = true;
  }

  private async applyTarget(target: AgentTurnActivityTarget): Promise<void> {
    switch (target.kind) {
      case 'inactive':
        await this.applyInactiveTarget(target.threadId);
        return;
      case 'terminal':
        await this.applyTerminalTarget(target);
        return;
      case 'retain':
        await this.applyRetainTarget(target.threadId);
        return;
      case 'active':
        await this.applyActiveTarget(target);
    }
  }

  private async applyInactiveTarget(threadId: string | null): Promise<void> {
    if (this.lingering && this.lingering.threadId !== threadId) {
      await this.clearLingering();
    }
    if (this.current) {
      await this.endCurrent({ kind: 'immediate' });
    }
  }

  private async applyTerminalTarget(
    target: Extract<AgentTurnActivityTarget, { kind: 'terminal' }>,
  ): Promise<void> {
    if (this.lingering && this.lingering.threadId !== target.threadId) {
      await this.clearLingering();
    }
    if (!this.current || this.current.threadId !== target.threadId) {
      return;
    }
    const props = this.propsForPhase(target.phase, this.current.props.startedAtEpochMs);
    await this.endCurrent(
      { kind: 'after', date: new Date(this.now() + TERMINAL_ACTIVITY_LINGER_MS) },
      props,
    );
  }

  private async applyRetainTarget(threadId: string): Promise<void> {
    if (this.lingering && this.lingering.threadId !== threadId) {
      await this.clearLingering();
    }
    if (this.current && this.current.threadId !== threadId) {
      await this.endCurrent({ kind: 'immediate' });
    }
  }

  private async applyActiveTarget(
    target: Extract<AgentTurnActivityTarget, { kind: 'active' }>,
  ): Promise<void> {
    const key = `${target.threadId}:${target.runId}`;
    if (this.current?.key !== key) {
      await this.clearLingering();
      if (this.current) {
        await this.endCurrent({ kind: 'immediate' });
      }
      const props = this.propsForPhase(target.phase, this.now());
      this.current = {
        key,
        threadId: target.threadId,
        handle: this.adapter.start(props, target.url),
        props,
      };
      return;
    }

    if (this.current.props.phase === target.phase) {
      return;
    }
    const props = this.propsForPhase(target.phase, this.current.props.startedAtEpochMs);
    await this.current.handle.update(props);
    this.current.props = props;
  }

  private propsForPhase(
    phase: AgentTurnActivityPhase,
    startedAtEpochMs: number,
  ): AgentTurnActivityProps {
    return {
      phase,
      startedAtEpochMs,
      updatedAtEpochMs: this.now(),
    };
  }

  private async endCurrent(
    dismissal: { kind: 'immediate' } | { kind: 'after'; date: Date },
    props?: AgentTurnActivityProps,
  ): Promise<void> {
    const current = this.current;
    if (!current) {
      return;
    }
    await current.handle.end(dismissal, props);
    if (this.current === current) {
      this.current = null;
      if (dismissal.kind === 'after') {
        this.lingering = {
          threadId: current.threadId,
          handle: current.handle,
          dismissAtEpochMs: dismissal.date.getTime(),
        };
      }
    }
  }

  private async clearLingering(): Promise<void> {
    const lingering = this.lingering;
    if (!lingering) {
      return;
    }
    this.lingering = null;
    if (this.now() >= lingering.dismissAtEpochMs) {
      return;
    }
    await lingering.handle.end({ kind: 'immediate' });
  }
}
