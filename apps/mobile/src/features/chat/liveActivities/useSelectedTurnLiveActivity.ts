import { useAtomValue } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';

import { activityAtom } from '../state/composer';
import { activeTurnIdAtom, pendingApprovalAtom, pendingUserInputRequestAtom } from '../state/turn';
import { agentTurnActivityAdapter } from './adapter';
import { AgentTurnActivityController, deriveAgentTurnActivityTarget } from './controller';
import { createAgentTurnActivityUrl } from './url';

export interface SelectedTurnLiveActivityInputs {
  profileId: string;
  threadId: string | null;
}

export function useSelectedTurnLiveActivity({
  profileId,
  threadId,
}: SelectedTurnLiveActivityInputs): void {
  const activeTurnId = useAtomValue(activeTurnIdAtom);
  const pendingApproval = useAtomValue(pendingApprovalAtom);
  const pendingUserInputRequest = useAtomValue(pendingUserInputRequestAtom);
  const activity = useAtomValue(activityAtom);
  const [controller] = useState(
    () =>
      new AgentTurnActivityController(agentTurnActivityAdapter, Date.now, (error) => {
        console.warn('Could not publish iOS Live Activity.', error);
      }),
  );
  const url = useMemo(
    () => (profileId && threadId ? createAgentTurnActivityUrl(profileId, threadId) : null),
    [profileId, threadId],
  );
  const target = useMemo(
    () =>
      deriveAgentTurnActivityTarget({
        profileId,
        threadId,
        activeTurnId,
        activity,
        hasPendingApproval: Boolean(pendingApproval),
        hasPendingUserInput: Boolean(pendingUserInputRequest),
        url,
      }),
    [activeTurnId, activity, pendingApproval, pendingUserInputRequest, profileId, threadId, url],
  );

  useEffect(() => {
    void controller.sync(target);
  }, [controller, target]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        void controller.reconcile();
      }
    });
    return () => {
      subscription.remove();
      void controller.dispose();
    };
  }, [controller]);
}
