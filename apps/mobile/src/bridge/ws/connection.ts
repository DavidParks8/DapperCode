import { HostBridgeWsClientCompletionAndDispatchLayer } from '@bridge/ws/completionAndDispatchLayer';

export { BridgeProtocolVersionError, isRpcRequestError, RpcRequestError } from '@bridge/ws/errors';

export class HostBridgeWsClient extends HostBridgeWsClientCompletionAndDispatchLayer {}
