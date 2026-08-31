import type { AgentTurnActivityAdapter } from './types';

export const agentTurnActivityAdapter: AgentTurnActivityAdapter = {
  supported: false,
  getInstances() {
    return Promise.resolve([]);
  },
  start() {
    throw new Error('Live Activities are only supported on iOS.');
  },
};
