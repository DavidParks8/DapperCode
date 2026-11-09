import type { LocalInputReply } from '../runtime/interactionTools';
import { LOCAL_RPC_ERROR, LocalRpcError } from './errors';
import type { LocalNotification } from './events';
import { readParam, type RpcParams } from './params';
import type { LocalAgentPort } from './port';

/** Reuses the bridge's question lifecycle, including list-on-reconnect and explicit resolution. */
export class LocalUserInputRelay {
  private delivered: ReturnType<LocalUserInputRelay['current']> = null;

  constructor(private readonly port: LocalAgentPort) {}

  private current() {
    return this.port.run().userInput ?? null;
  }

  prime(): void {
    this.delivered = this.current();
  }

  list() {
    const request = this.current();
    return request ? [request] : [];
  }

  diff(): LocalNotification[] {
    const previous = this.delivered;
    const next = this.current();
    if (previous?.requestId === next?.requestId) {
      return [];
    }
    this.delivered = next;
    return [
      ...(previous
        ? [
            {
              method: 'bridge/userInput.resolved',
              params: { id: previous.requestId, threadId: previous.threadId },
            },
          ]
        : []),
      ...(next ? [{ method: 'bridge/userInput.requested', params: { ...next } }] : []),
    ];
  }

  resolve(params: RpcParams) {
    const request = this.current();
    if (!request || request.requestId !== readParam(params, 'id')) {
      throw new LocalRpcError(LOCAL_RPC_ERROR.notFound, 'This question is no longer pending.', {
        error: 'on_device_failed',
      });
    }
    const action = params['action'];
    if (
      action !== undefined &&
      action !== 'submit' &&
      action !== 'cancel' &&
      action !== 'decline'
    ) {
      throw new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'Choose cancel or decline.', {
        error: 'on_device_failed',
      });
    }
    this.port.resolveUserInput(request.requestId, {
      answers: params['answers'],
      ...(action === undefined ? {} : { action }),
    } as LocalInputReply);
    return { ok: true, request };
  }
}
