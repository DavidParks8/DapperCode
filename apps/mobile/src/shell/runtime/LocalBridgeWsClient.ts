import type { LocalRpcEndpoint } from '../../features/on-device/transport/server';
import { LocalRpcError } from '../../features/on-device/transport/server';
import { RpcRequestError } from '@bridge/ws/errors';
import { HostBridgeWsClient } from '@bridge/ws/ws';

export const LOCAL_TRANSPORT_URL = 'local://on-device';

/**
 * Plugs the in-process local RPC endpoint into the bridge client seam. The shell, chat screen, and
 * `HostBridgeApiClient` keep using a `HostBridgeWsClient`; requests are answered by the on-device
 * agent instead of a socket, and its notifications are delivered through the same parsing path a
 * socket notification takes (turn-completion tracking, then listeners).
 *
 * There is no socket, so reconnect, replay, and push presence are inert. The client stays
 * connected until it is disposed; `disconnect()` from foreground/background lifecycles is a no-op
 * because the on-device runtime owns its own background behaviour.
 */
export class LocalBridgeWsClient extends HostBridgeWsClient {
  private readonly removeNotificationListener: () => void;
  private disposed = false;

  constructor(private readonly endpoint: LocalRpcEndpoint) {
    // Local turns can legitimately run for many minutes while a model loads and generates.
    super(LOCAL_TRANSPORT_URL, { requestTimeoutMs: 30 * 60 * 1000 });
    this.removeNotificationListener = endpoint.onNotification((notification) => {
      if (!this.disposed) {
        this.handleNotificationRecord({
          method: notification.method,
          params: notification.params,
        });
      }
    });
  }

  override connect(): void {
    if (this.disposed || this.connected) {
      return;
    }
    this.endpoint.start();
    this.emitStatus(true);
  }

  override disconnect(): void {
    // Kept connected: the runtime, not the socket lifecycle, owns local background behaviour.
  }

  override resetRecoveryEpoch(): void {
    // There is no replay stream to reset for an in-process transport.
  }

  override acknowledgeSnapshotRecovery(
    ...args: Parameters<HostBridgeWsClient['acknowledgeSnapshotRecovery']>
  ): boolean {
    void args;
    return false;
  }

  override notify(...args: Parameters<HostBridgeWsClient['notify']>): boolean {
    void args;
    // Push presence and observations only matter to a remote bridge.
    return false;
  }

  override async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) {
      throw new Error('On this iPhone is no longer active.');
    }
    try {
      return (await this.endpoint.request(method, params)) as T;
    } catch (error) {
      if (error instanceof LocalRpcError) {
        throw new RpcRequestError(method, error.code, error.message, error.data);
      }
      throw error;
    }
  }

  /** Stops event delivery and marks the transport disconnected. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeNotificationListener();
    this.endpoint.stop();
    this.emitStatus(false);
    this.eventListeners.clear();
    this.statusListeners.clear();
  }
}

export function isLocalBridgeWsClient(client: unknown): client is LocalBridgeWsClient {
  return client instanceof LocalBridgeWsClient;
}
