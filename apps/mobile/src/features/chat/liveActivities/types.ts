import type {
  DapperCodeAgentActivityPhase,
  DapperCodeAgentActivityProps,
} from '../../../../widgets/DapperCodeAgentActivity';

export type AgentTurnActivityPhase = DapperCodeAgentActivityPhase;
export type AgentTurnActivityProps = DapperCodeAgentActivityProps;

export type AgentTurnActivityDismissal = { kind: 'immediate' } | { kind: 'after'; date: Date };

export interface AgentTurnActivityHandle {
  update(props: AgentTurnActivityProps): Promise<void>;
  end(dismissal: AgentTurnActivityDismissal, props?: AgentTurnActivityProps): Promise<void>;
}

export interface AgentTurnActivityAdapter {
  readonly supported: boolean;
  getInstances(): Promise<AgentTurnActivityHandle[]>;
  start(props: AgentTurnActivityProps, url: string): AgentTurnActivityHandle;
}
