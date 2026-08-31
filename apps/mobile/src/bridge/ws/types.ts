import type { RpcNotification } from '@bridge/types/types';

export const MOBILE_BRIDGE_CLIENT_TYPE = 'mobile';
export const MOBILE_BRIDGE_CLIENT_NAME = 'DapperCode Mobile';
export const PUSH_CANDIDATE_METHOD = 'bridge/push/candidate';
export const PUSH_OBSERVED_METHOD = 'bridge/push/observed';
export const PUSH_PRESENCE_METHOD = 'bridge/push/presence';

export type EventListener = (event: RpcNotification) => void;
export type StatusListener = (connected: boolean) => void;

export interface HostBridgeWsClientOptions {
  authToken?: string | null;
  workspaceId?: string | null;
  clientType?: string | null;
  clientName?: string | null;
  getClientForeground?: (() => boolean) | null;
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
