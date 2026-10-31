import type { PendingApproval } from '@bridge/types/types';
import { LOCAL_RPC_ERROR, LocalRpcError } from './errors';
import type { LocalNotification } from './events';
import { readParam, type RpcParams } from './params';
import type { LocalAgentPort } from './port';
import { LOCAL_AGENT_ID } from './wire';

export const LOCAL_APPROVAL_ALLOW = 'allow-once';
export const LOCAL_APPROVAL_DENY = 'reject-once';

/**
 * Presents the agent loop's pending tool approval (for example a push) as a bridge approval, so the
 * shell's existing approval banner asks the user and `bridge/approvals/resolve` answers the loop.
 */
export class LocalApprovalRelay {
  private delivered: PendingApproval | null = null;

  constructor(private readonly port: LocalAgentPort) {}

  prime(): void {
    this.delivered = this.current();
  }

  list(): PendingApproval[] {
    const approval = this.current();
    return approval ? [approval] : [];
  }

  /** Notifications for an approval that appeared or was answered since the last call. */
  diff(): LocalNotification[] {
    const next = this.current();
    const previous = this.delivered;
    if (next?.requestId === previous?.requestId) {
      return [];
    }
    this.delivered = next;
    return [
      ...(previous
        ? [
            {
              method: 'bridge/approval.resolved',
              params: { id: previous.requestId, threadId: previous.threadId },
            },
          ]
        : []),
      ...(next ? [{ method: 'bridge/approval.requested', params: { ...next } }] : []),
    ];
  }

  resolve(params: RpcParams) {
    const approval = this.current();
    const decision = readParam(params, 'decision');
    if (!approval || approval.requestId !== readParam(params, 'id')) {
      throw new LocalRpcError(LOCAL_RPC_ERROR.notFound, 'This approval is no longer pending.', {
        error: 'on_device_failed',
      });
    }
    if (decision !== LOCAL_APPROVAL_ALLOW && decision !== LOCAL_APPROVAL_DENY) {
      throw new LocalRpcError(LOCAL_RPC_ERROR.invalidParams, 'Choose Allow or Deny.', {
        error: 'on_device_failed',
      });
    }
    this.port.resolveApproval(approval.requestId, decision === LOCAL_APPROVAL_ALLOW);
    return { ok: true, approval, decision, resolutionId: readParam(params, 'resolutionId') ?? '' };
  }

  /** The pending approval keyed by tool call; stable while the same call is waiting. */
  private current(): PendingApproval | null {
    const approval = this.port.run().approval;
    if (!approval) {
      return null;
    }
    if (this.delivered?.requestId === approval.callId) {
      return this.delivered;
    }
    return {
      requestId: approval.callId,
      agentId: LOCAL_AGENT_ID,
      kind: 'toolCall',
      threadId: approval.threadId,
      turnId: approval.turnId,
      itemId: approval.callId,
      title: approval.summary,
      message: approval.summary,
      reason: approval.summary,
      requestedAt: new Date().toISOString(),
      options: [
        { id: LOCAL_APPROVAL_ALLOW, label: 'Allow', kind: 'AllowOnce' },
        { id: LOCAL_APPROVAL_DENY, label: 'Deny', kind: 'RejectOnce' },
      ],
    };
  }
}
