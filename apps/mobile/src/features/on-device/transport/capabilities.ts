import type {
  AgentDescriptor,
  BridgeCapabilities,
  BridgeCapabilitySupport,
} from '@bridge/types/types';
import { LOCAL_AGENT_ID, LOCAL_AGENT_NAME } from './wire';

export const LOCAL_STREAM_ID = 'on-device';
export const LOCAL_PROTOCOL_VERSION = 2;

/**
 * What the local agent supports. Everything false is hidden by the chat shell (steer/queue,
 * forking, plan mode, browser preview, review, bridge UI surfaces, fast mode).
 */
export const LOCAL_CAPABILITY_SUPPORT: BridgeCapabilitySupport = {
  reviewStart: false,
  goalSlash: false,
  planMode: false,
  agentList: false,
  turnSteer: false,
  threadFork: false,
  threadDelete: true,
  commandOutputDelta: false,
  fastMode: false,
  browserPreview: false,
  genericUiSurface: false,
};

export function localCapabilities(): BridgeCapabilities {
  const agent: AgentDescriptor = {
    agentId: LOCAL_AGENT_ID,
    displayName: LOCAL_AGENT_NAME,
    icon: null,
    version: '1',
    provenance: 'Built into DapperCode',
    lifecycle: 'ready',
    capabilities: {
      sessionList: true,
      sessionLoad: true,
      sessionResume: true,
      sessionSteer: false,
      sessionFork: false,
      sessionDelete: true,
    },
  };
  return {
    protocolVersion: LOCAL_PROTOCOL_VERSION,
    streamId: LOCAL_STREAM_ID,
    preferredAgentId: LOCAL_AGENT_ID,
    activeAgentId: LOCAL_AGENT_ID,
    agents: [agent],
    supportsByAgent: { [LOCAL_AGENT_ID]: LOCAL_CAPABILITY_SUPPORT },
    agUiEvents: true,
    supports: LOCAL_CAPABILITY_SUPPORT,
  };
}
