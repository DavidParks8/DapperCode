import type { BridgeSnapshotRequiredReason, RpcNotification } from '@bridge/types/types';
import type { BridgeProtocolVersionError } from '@bridge/ws/errors';
import type {
  EventListener,
  HostBridgeWsClientOptions,
  PendingRequest,
  StatusListener,
  TurnCompletionSnapshot,
} from '@bridge/ws/types';
import { PUSH_OBSERVED_METHOD, PUSH_PRESENCE_METHOD } from '@bridge/ws/types';

export abstract class HostBridgeWsClientCore {
  static readonly PROTOCOL_VERSION = 2;
  protected static readonly TURN_COMPLETION_TTL_MS = 5 * 60 * 1000;
  protected static readonly MAX_RECOVERY_BUFFERED_EVENTS = 2048;
  protected socket: WebSocket | null = null;
  protected pendingSocket: WebSocket | null = null;
  protected connected = false;
  protected shouldReconnect = false;
  protected reconnectAttempts = 0;
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected connectPromise: Promise<void> | null = null;
  protected connectGeneration = 0;
  protected readonly eventListeners = new Set<EventListener>();
  protected readonly statusListeners = new Set<StatusListener>();
  protected readonly beforeDisconnectListeners = new Set<() => void>();
  protected readonly pendingRequests = new Map<string | number, PendingRequest>();
  protected readonly recentTurnCompletions = new Map<string, TurnCompletionSnapshot>();
  protected readonly pendingEvents = new Map<number, RpcNotification>();
  protected readonly authToken: string | null;
  protected readonly workspaceId: string | null;
  protected readonly clientType: string | null;
  protected readonly clientName: string | null;
  protected readonly getClientForeground: (() => boolean) | null;
  protected readonly allowQueryTokenAuth: boolean;
  protected readonly baseUrl: string;
  protected readonly requestTimeoutMs: number;
  protected lastSeenEventId = 0;
  protected replaySupported = true;
  protected replayInFlight: Promise<void> | null = null;
  protected replayGeneration = 0;
  protected recoveryWatermark: number | null = null;
  protected awaitingFreshRecoveryBaseline = false;
  protected requestCounter = 0;
  protected pushPresenceSequence = 0;
  protected streamId: string | null = null;
  protected protocolError: BridgeProtocolVersionError | null = null;
  constructor(baseUrl: string, options: HostBridgeWsClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.authToken = options.authToken?.trim() || null;
    this.workspaceId = options.workspaceId?.trim() || null;
    this.clientType = options.clientType?.trim() || null;
    this.clientName = options.clientName?.trim() || null;
    this.getClientForeground = options.getClientForeground ?? null;
    this.allowQueryTokenAuth = options.allowQueryTokenAuth ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 180000;
  }
  public abstract get isConnected(): boolean;
  public abstract get bridgeProtocolError(): BridgeProtocolVersionError | null;
  abstract acknowledgeSnapshotRecovery(resumeAfterEventId: number): boolean;
  abstract connect(): void;
  abstract resetRecoveryEpoch(): void;
  protected abstract startConnect(): void;
  abstract disconnect(): void;
  onBeforeDisconnect(listener: () => void): () => void {
    this.beforeDisconnectListeners.add(listener);
    return () => this.beforeDisconnectListeners.delete(listener);
  }
  abstract notify(method: string, params?: unknown): boolean;
  reportPushPresence(foreground: boolean): boolean {
    this.pushPresenceSequence += 1;
    return this.notify(PUSH_PRESENCE_METHOD, {
      foreground,
      sequence: this.pushPresenceSequence,
    });
  }
  reportPushObservation(candidateId: string): boolean {
    return this.notify(PUSH_OBSERVED_METHOD, {
      candidateId,
      presenceSequence: this.pushPresenceSequence,
    });
  }
  abstract request<T>(method: string, params?: unknown): Promise<T>;
  abstract waitForTurnCompletion(
    threadId: string,
    turnId: string,
    timeoutMs?: number,
  ): Promise<void>;
  abstract onEvent(listener: EventListener): () => void;
  abstract onStatus(listener: StatusListener): () => void;
  protected abstract ensureConnected(): Promise<void>;
  protected abstract openSocket(generation: number): Promise<void>;
  protected abstract scheduleReconnect(): void;
  protected abstract handleIncoming(raw: string): void;
  protected abstract handleNotificationRecord(
    record: Record<string, unknown>,
    options?: { source?: 'live' | 'replay' },
  ): void;
  protected abstract scheduleReplay(): void;
  protected abstract replayMissedEvents(generation: number): Promise<void>;
  protected abstract drainPendingEvents(): void;
  protected abstract hasPendingGap(): boolean;
  protected abstract emitNumberedEvent(event: RpcNotification): void;
  protected abstract resetDeliveryEpoch(
    reason: BridgeSnapshotRequiredReason,
    earliestEventId: number | null,
    latestEventId: number | null,
    previousStreamId?: string | null,
  ): void;
  protected abstract handleRecoveryBufferOverflow(): void;
  protected abstract applyStreamIdentity(
    protocolVersion: number | null,
    streamId: string | null,
  ): 'missing' | 'initial' | 'same' | 'changed' | 'unsupported';
  protected abstract rejectAllPending(error: Error): void;
  protected abstract getTurnCompletion(
    threadId: string,
    turnId: string,
  ): TurnCompletionSnapshot | null;
  protected abstract rememberTurnCompletion(snapshot: TurnCompletionSnapshot): void;
  protected abstract pruneTurnCompletions(): void;
  protected abstract assertTurnSucceeded(snapshot: TurnCompletionSnapshot): void;
  protected abstract emitEvent(event: RpcNotification): void;
  protected abstract emitStatus(connected: boolean): void;
  protected abstract socketUrl(): string;
  protected abstract shouldUseQueryTokenAuth(): boolean;
}
