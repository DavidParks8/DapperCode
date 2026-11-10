import { LOCAL_RUN_EXPIRED_EVENT, type OnDeviceNativeServices } from '../native/services.types';
import type { LocalRunSnapshot, LocalThread } from './types';

/** iOS may expire a continued-processing task whose progress stalls, so progress is reported. */
export const LOCAL_RUN_HEARTBEAT_MS = 5_000;
export const LOCAL_RUN_ACTIVITY_TITLE = 'Local agent';
export const LOCAL_RUN_EXPIRED_MESSAGE =
  'iOS ended background time for this turn. Completed edits are preserved; retry to continue.';

type ActivityNative = Pick<
  OnDeviceNativeServices,
  'addListener' | 'beginLocalRunActivity' | 'updateLocalRunActivity' | 'endLocalRunActivity'
>;

/**
 * The run's description in the system progress UI, which can appear on the Lock Screen, so it
 * names the phase and tool but never conversation content or approval details.
 */
export function localRunActivitySubtitle(run: LocalRunSnapshot): string {
  switch (run.phase) {
    case 'idle':
    case 'preparing':
      return 'Preparing';
    case 'generating':
      return 'Generating on this iPhone';
    case 'compacting':
      return 'Summarizing the conversation';
    case 'tool':
      return `Running ${run.toolName ?? 'a local tool'}`;
    case 'approval':
      return 'Waiting for your approval';
    case 'input':
      return 'Waiting for your answers';
    case 'stopping':
      return 'Stopping';
    case 'persisting':
      return 'Saving';
  }
}

interface Hold {
  expired: boolean;
  subtitle: string;
}

export interface LocalRunHost {
  /** The run's current description for the system progress UI. */
  subtitle(): string;
  /** iOS revoked the background time or the user cancelled it; the run must stop. */
  expired(): void;
  /** Work that must finish before a settled turn gives its time back; never rejects. */
  settled(): Promise<void> | null;
}

/**
 * Keeps the process running while local turns are in flight, so locking the phone or switching
 * apps does not freeze them. Unlike the bridge connection, which closes in the background to save
 * battery, a local turn holds a native activity from admission until it settles.
 */
export class LocalRunActivities {
  private readonly holds = new Map<string, Hold>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly subscription: { remove(): void };

  constructor(
    private readonly native: ActivityNative,
    private readonly host: LocalRunHost,
    private readonly heartbeatMs = LOCAL_RUN_HEARTBEAT_MS,
  ) {
    this.subscription = native.addListener(LOCAL_RUN_EXPIRED_EVENT, ({ id }) => this.expire(id));
  }

  /** True while iOS lets an in-flight turn keep running in the background. */
  held(): boolean {
    return [...this.holds.values()].some((hold) => !hold.expired);
  }

  /**
   * Runs a turn under an activity begun before admission, so locking the phone or switching apps
   * keeps it going. Without background time, leaving the app stops the turn as before.
   */
  async run(admit: () => Promise<void>, start: () => Promise<LocalThread>): Promise<LocalThread> {
    const id = await this.begin();
    let success = false;
    try {
      await admit();
      const thread = await start();
      success = thread.status === 'complete';
      return thread;
    } finally {
      // Even a turn refused at admission may have kept the app running after the phone locked.
      const settling = this.host.settled();
      if (settling) {
        void settling.finally(() => this.end(id, success));
      } else {
        this.end(id, success);
      }
    }
  }

  /** Call while the app is active. Null means no background time; the turn still runs. */
  async begin(): Promise<string | null> {
    const subtitle = this.host.subtitle();
    let activity;
    try {
      activity = await this.native.beginLocalRunActivity(LOCAL_RUN_ACTIVITY_TITLE, subtitle);
    } catch {
      return null;
    }
    if (activity.kind === 'none') {
      return null;
    }
    this.holds.set(activity.id, { expired: false, subtitle });
    this.heartbeat ??= setInterval(() => this.report(true), this.heartbeatMs);
    return activity.id;
  }

  /** Mirrors a run change into the system progress UI when its description changed. */
  changed(): void {
    this.report(false);
  }

  end(id: string | null, success: boolean): void {
    if (id === null || !this.holds.delete(id)) {
      return;
    }
    this.native.endLocalRunActivity(id, success);
    if (this.holds.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  dispose(): void {
    for (const id of [...this.holds.keys()]) {
      this.end(id, false);
    }
    this.subscription.remove();
  }

  private report(heartbeat: boolean): void {
    if (this.holds.size === 0) {
      return;
    }
    const subtitle = this.host.subtitle();
    for (const [id, hold] of this.holds) {
      if (!hold.expired && (heartbeat || hold.subtitle !== subtitle)) {
        hold.subtitle = subtitle;
        this.native.updateLocalRunActivity(id, subtitle);
      }
    }
  }

  private expire(id: string): void {
    const hold = this.holds.get(id);
    if (hold && !hold.expired) {
      hold.expired = true;
      this.host.expired();
    }
  }
}
