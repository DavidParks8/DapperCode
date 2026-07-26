import type { RpcNotification } from './types';

export type EventListener = (event: RpcNotification) => void;
export type StatusListener = (connected: boolean) => void;

export interface HostBridgeWsClientOptions {
  authToken?: string | null;
  allowQueryTokenAuth?: boolean;
  requestTimeoutMs?: number;
}

export interface ReactNativeWebSocketConstructor {
  new (
    url: string,
    protocols?: string | string[],
    options?: {
      headers?: Record<string, string>;
    },
  ): WebSocket;
}

export interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface TurnCompletionSnapshot {
  threadId: string;
  turnId: string | null;
  status: string | null;
  errorMessage: string | null;
  completedAt: number;
}

export interface ReplayEventsResponse {
  protocolVersion?: number;
  streamId?: string;
  events?: unknown[];
  hasMore?: boolean;
  earliestEventId?: number;
  latestEventId?: number;
  truncatedByBytes?: boolean;
  returnedBytes?: number;
  maxBytes?: number;
}
