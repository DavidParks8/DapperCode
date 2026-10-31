import { ON_DEVICE_RUNTIME_SLICES, type OnDeviceRuntimeSlice } from './types';

/** Minimum spacing between renders caused by high-frequency slices such as token streams. */
export const COALESCED_EMIT_INTERVAL_MS = 50;

export class RuntimeSliceEmitter {
  private readonly versions = new Map<OnDeviceRuntimeSlice, number>();
  private readonly listeners = new Map<() => void, ReadonlySet<OnDeviceRuntimeSlice>>();
  private readonly pending = new Set<OnDeviceRuntimeSlice>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastCoalescedFlush = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly intervalMs = COALESCED_EMIT_INTERVAL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  subscribe(
    listener: () => void,
    slices: readonly OnDeviceRuntimeSlice[] = ON_DEVICE_RUNTIME_SLICES,
  ): () => void {
    this.listeners.set(listener, new Set(slices));
    return () => {
      this.listeners.delete(listener);
    };
  }

  version(slices: readonly OnDeviceRuntimeSlice[] = ON_DEVICE_RUNTIME_SLICES): number {
    let total = 0;
    for (const slice of slices) {
      total += this.versions.get(slice) ?? 0;
    }
    return total;
  }

  /** Notifies immediately, including any coalesced changes that are still pending. */
  emit(...slices: OnDeviceRuntimeSlice[]): void {
    for (const slice of slices) {
      this.pending.add(slice);
    }
    this.flush();
  }

  /** Notifies at most once per interval; the first change in a quiet period is immediate. */
  coalesce(slice: OnDeviceRuntimeSlice): void {
    this.pending.add(slice);
    if (this.timer) {
      return;
    }
    const wait = this.lastCoalescedFlush + this.intervalMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) {
      return;
    }
    this.lastCoalescedFlush = this.now();
    const changed = [...this.pending];
    this.pending.clear();
    for (const slice of changed) {
      this.versions.set(slice, (this.versions.get(slice) ?? 0) + 1);
    }
    for (const [listener, slices] of [...this.listeners]) {
      if (changed.some((slice) => slices.has(slice))) {
        listener();
      }
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
