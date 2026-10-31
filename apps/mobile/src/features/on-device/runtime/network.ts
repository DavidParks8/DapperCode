import type { OnDeviceReachability } from './types';

export interface OnDeviceNetworkState {
  isConnected?: boolean | null;
  isInternetReachable?: boolean | null;
}

export interface OnDeviceNetworkPort {
  current(): Promise<OnDeviceReachability>;
  subscribe(listener: (value: OnDeviceReachability) => void): () => void;
}

export function reachability(state: OnDeviceNetworkState): OnDeviceReachability {
  if (state.isConnected === false || state.isInternetReachable === false) {
    return 'offline';
  }
  if (state.isConnected === true) {
    return 'online';
  }
  return 'unknown';
}

/** Used when no platform network observer is available; never pre-empts network actions. */
export const unknownNetwork: OnDeviceNetworkPort = {
  current: () => Promise.resolve('unknown'),
  subscribe: () => () => undefined,
};

export class OnDeviceOfflineError extends Error {
  constructor(action: string) {
    super(`You're offline. Connect to the internet to ${action}.`);
    this.name = 'OnDeviceOfflineError';
  }
}

/** Tracks reachability so network actions can fail fast with a friendly message. */
export class NetworkMonitor {
  private value: OnDeviceReachability = 'unknown';
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly port: OnDeviceNetworkPort,
    private readonly changed: (value: OnDeviceReachability) => void,
  ) {}

  current(): OnDeviceReachability {
    return this.value;
  }

  /** Starts observing; a no-op once closed so a late start cannot leak a listener. */
  async start(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.unsubscribe ??= this.port.subscribe((value) => this.set(value));
    let value: OnDeviceReachability = 'unknown';
    try {
      value = await this.port.current();
    } catch {
      value = 'unknown';
    }
    if (!this.closed) {
      this.set(value);
    }
  }

  /** Throws `OnDeviceOfflineError` only when the device is known to be offline. */
  require(action: string): void {
    if (this.value === 'offline') {
      throw new OnDeviceOfflineError(action);
    }
  }

  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private set(value: OnDeviceReachability): void {
    if (this.value !== value) {
      this.value = value;
      this.changed(value);
    }
  }
}
