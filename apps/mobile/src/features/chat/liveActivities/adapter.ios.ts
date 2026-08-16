import { after, type LiveActivity } from 'expo-widgets';

import DapperCodeAgentActivity from '../../../../widgets/DapperCodeAgentActivity';
import type {
  AgentTurnActivityAdapter,
  AgentTurnActivityDismissal,
  AgentTurnActivityHandle,
  AgentTurnActivityProps,
} from './types';

function wrapActivity(activity: LiveActivity<AgentTurnActivityProps>): AgentTurnActivityHandle {
  return {
    update(props) {
      return activity.update(props);
    },
    end(dismissal: AgentTurnActivityDismissal, props?: AgentTurnActivityProps) {
      const policy = dismissal.kind === 'immediate' ? 'immediate' : after(dismissal.date);
      return activity.end(policy, props, new Date());
    },
  };
}

export const agentTurnActivityAdapter: AgentTurnActivityAdapter = {
  supported: true,
  getInstances() {
    return Promise.resolve(DapperCodeAgentActivity.getInstances().map(wrapActivity));
  },
  start(props, url) {
    return wrapActivity(DapperCodeAgentActivity.start(props, url));
  },
};
