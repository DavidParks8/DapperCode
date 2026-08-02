export { readString, toRecord } from '@shared/runtimeValidation';
export { toPreview } from '@bridge/mapping/chatMappingRawTypesAndReaders';
export { toRawThread } from '@bridge/mapping/chatMappingStatusAndErrorProjection';
export { mapChatSummary } from '@bridge/mapping/chatMappingSnapshotAndSummaryProjection';
export { mapChat, applySnapshotToChat } from '@bridge/mapping/chatMappingChatProjection';
export type {
  RawThreadStatus,
  RawTurn,
  RawThreadItem,
  RawThread,
  RawAcpSnapshot,
  RawSnapshotCollectionMetadata,
  RawSnapshotContinuation,
} from '@bridge/mapping/chatMappingRawTypesAndReaders';
