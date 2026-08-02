import { HostBridgeWsClientSocketTransportLayer } from './HostBridgeWsClientSocketTransportLayer';
import { HostBridgeWsClientCore } from './HostBridgeWsClientCore';
import { BridgeProtocolVersionError, isRpcRequestError } from './wsErrors';
import { readIntegerLike, readString, toRecord } from '../runtimeValidation';
import { readEventId, toAgUiTurnCompletionSnapshot } from './wsEventParsingInternals';
import {
  type BridgeSnapshotRequiredParams,
  type BridgeSnapshotRequiredReason,
  type RpcNotification,
} from './types';
import { type ReplayEventsResponse } from './wsTypes';

export abstract class HostBridgeWsClientReplayAndOrderingLayer extends HostBridgeWsClientSocketTransportLayer {
  protected scheduleReplay(): void {
    if (!this.replaySupported) {
      return;
    }
    if (this.replayInFlight) {
      return;
    }
    if (!this.connected || !this.socket || this.socket.readyState !== 1) {
      return;
    }
    const generation = this.replayGeneration;
    let replayCompleted = false;
    const replayPromise = this.replayMissedEvents(generation)
      .then(() => {
        replayCompleted = true;
      })
      .catch(() => {
        // Keep buffered events for retry on the next live event or reconnect.
      })
      .finally(() => {
        if (this.replayInFlight !== replayPromise) {
          return;
        }
        this.replayInFlight = null;
        if (!replayCompleted || generation !== this.replayGeneration) {
          return;
        }
        this.drainPendingEvents();
        if (this.hasPendingGap()) {
          this.scheduleReplay();
        }
      });
    this.replayInFlight = replayPromise;
  }
  protected classifyReplayRequestError(error: unknown): 'unsupported' | 'fatal' {
    return isRpcRequestError(error) && error.code === -32601 ? 'unsupported' : 'fatal';
  }
  protected checkReplayPageIntegrity(
    cursor: number,
    earliestEventId: number | null,
    latestEventId: number | null,
  ): BridgeSnapshotRequiredReason | null {
    if (latestEventId !== null && latestEventId < cursor) {
      return 'replayInconsistent';
    }
    if (earliestEventId !== null && earliestEventId > cursor + 1) {
      return 'replayTruncated';
    }
    if (earliestEventId === null && latestEventId !== null && latestEventId > cursor) {
      return 'replayTruncated';
    }
    return null;
  }
  protected applyReplayEvents(events: unknown[]): void {
    for (const entry of events) {
      const record = toRecord(entry);
      if (!record) {
        continue;
      }
      this.handleNotificationRecord(record, { source: 'replay' });
    }
  }
  protected extractPageEventIds(events: unknown[]): number[] {
    return events
      .map((entry) => toRecord(entry))
      .map((entry) => (entry ? readEventId(entry) : null))
      .filter((eventId): eventId is number => eventId !== null);
  }
  protected resolveReplayTargetEventId(
    targetEventId: number | null,
    latestEventId: number | null,
    pageEventIds: number[],
  ): number | null {
    if (targetEventId !== null) {
      return targetEventId;
    }
    if (latestEventId !== null) {
      return latestEventId;
    }
    return pageEventIds.length > 0 ? Math.max(...pageEventIds) : null;
  }
  protected async replayMissedEvents(generation: number): Promise<void> {
    if (!this.replaySupported) {
      return;
    }
    let cursor = this.lastSeenEventId;
    let targetEventId: number | null = null;
    while (generation === this.replayGeneration) {
      let response: ReplayEventsResponse;
      try {
        response = await this.request<ReplayEventsResponse>('bridge/events/replay', {
          afterEventId: cursor,
          limit: 200,
        });
      } catch (error) {
        if (this.classifyReplayRequestError(error) === 'unsupported') {
          this.replaySupported = false;
          return;
        }
        throw error;
      }
      if (generation !== this.replayGeneration) {
        return;
      }
      const identityResult = this.applyStreamIdentity(
        readIntegerLike(response.protocolVersion),
        readString(response.streamId),
      );
      if (identityResult === 'unsupported' || identityResult === 'changed') {
        return;
      }
      const latestEventId = readIntegerLike(response.latestEventId);
      const earliestEventId = readIntegerLike(response.earliestEventId);
      const integrityFailure = this.checkReplayPageIntegrity(
        cursor,
        earliestEventId,
        latestEventId,
      );
      if (integrityFailure) {
        this.resetDeliveryEpoch(integrityFailure, earliestEventId, latestEventId);
        return;
      }
      const events = Array.isArray(response.events) ? response.events : [];
      this.applyReplayEvents(events);
      const previousCursor = cursor;
      cursor = this.lastSeenEventId;
      const pageEventIds = this.extractPageEventIds(events);
      targetEventId = this.resolveReplayTargetEventId(targetEventId, latestEventId, pageEventIds);
      if (targetEventId === null || cursor >= targetEventId) {
        return;
      }
      const hasMore = response.hasMore === true;
      if (!hasMore || cursor <= previousCursor) {
        this.resetDeliveryEpoch('replayInconsistent', earliestEventId, latestEventId);
        return;
      }
    }
  }
  protected drainPendingEvents(): void {
    if (this.recoveryWatermark !== null) {
      return;
    }
    let nextEventId = this.lastSeenEventId + 1;
    while (this.pendingEvents.has(nextEventId)) {
      const event = this.pendingEvents.get(nextEventId);
      this.pendingEvents.delete(nextEventId);
      if (event) {
        this.emitNumberedEvent(event);
      }
      nextEventId = this.lastSeenEventId + 1;
    }
  }
  protected hasPendingGap(): boolean {
    if (this.pendingEvents.size === 0) {
      return false;
    }
    return !this.pendingEvents.has(this.lastSeenEventId + 1);
  }
  protected emitNumberedEvent(event: RpcNotification): void {
    if (typeof event.eventId !== 'number') {
      return;
    }
    this.lastSeenEventId = event.eventId;
    const completion = toAgUiTurnCompletionSnapshot(event);
    if (completion?.turnId) {
      this.rememberTurnCompletion(completion);
    }
    this.emitEvent(event);
  }
  protected resetDeliveryEpoch(
    reason: BridgeSnapshotRequiredReason,
    earliestEventId: number | null,
    latestEventId: number | null,
    previousStreamId: string | null = this.streamId,
  ): void {
    const lastDeliveredEventId = this.lastSeenEventId;
    const resumeAfterEventId = latestEventId ?? 0;
    this.replayGeneration += 1;
    if (reason === 'streamChanged') {
      this.pendingEvents.clear();
    } else {
      for (const eventId of this.pendingEvents.keys()) {
        if (eventId <= resumeAfterEventId) {
          this.pendingEvents.delete(eventId);
        }
      }
    }
    this.lastSeenEventId = resumeAfterEventId;
    this.recoveryWatermark = resumeAfterEventId;
    this.replayInFlight = null;
    const params: BridgeSnapshotRequiredParams = {
      reason,
      previousStreamId,
      lastDeliveredEventId,
      resumeAfterEventId,
      earliestEventId,
      latestEventId,
    };
    this.emitEvent({
      method: 'bridge/events/snapshotRequired',
      protocolVersion: HostBridgeWsClientCore.PROTOCOL_VERSION,
      streamId: this.streamId ?? undefined,
      params: params as unknown as Record<string, unknown>,
    });
  }
  protected handleRecoveryBufferOverflow(): void {
    this.resetRecoveryEpoch();
  }
  protected applyStreamIdentity(
    protocolVersion: number | null,
    streamId: string | null,
  ): 'missing' | 'initial' | 'same' | 'changed' | 'unsupported' {
    if (protocolVersion === null || !streamId) {
      return 'missing';
    }
    if (protocolVersion !== HostBridgeWsClientCore.PROTOCOL_VERSION) {
      const error = new BridgeProtocolVersionError(protocolVersion);
      this.protocolError = error;
      this.shouldReconnect = false;
      this.connectGeneration += 1;
      this.rejectAllPending(error);
      this.socket?.close();
      return 'unsupported';
    }
    this.protocolError = null;
    if (this.streamId === null) {
      this.streamId = streamId;
      return 'initial';
    }
    if (this.streamId === streamId) {
      return 'same';
    }
    const previousStreamId = this.streamId;
    this.streamId = streamId;
    this.resetDeliveryEpoch('streamChanged', null, null, previousStreamId);
    return 'changed';
  }
  protected rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}
