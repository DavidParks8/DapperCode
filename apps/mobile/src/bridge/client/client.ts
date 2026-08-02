import { HostBridgeApiClientTurnPreparationLayer } from '@bridge/client/turnPreparationLayer';

export { StaleSnapshotRevisionError } from '@bridge/client/clientSnapshotErrors';
export { mergeSnapshotPage } from '@bridge/client/clientContractsAndSnapshotInternals';
export type {
  SnapshotPageEntry,
  SnapshotPageResponse,
  SendOrQueueChatMessageResult,
} from '@bridge/client/clientContractsAndSnapshotInternals';
export type { ChatListResult } from '@bridge/client/clientChatListInternals';

export class HostBridgeApiClient extends HostBridgeApiClientTurnPreparationLayer {}
