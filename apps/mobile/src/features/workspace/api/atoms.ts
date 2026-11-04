import { atom } from 'jotai';

import { wsClientAtom } from '@shell/state/bridge/atoms';
import { WorkspaceHostClient } from './client';

/** Workspace host extensions over the active profile's transport, or null before it exists. */
export const workspaceHostClientAtom = atom((get) => {
  const ws = get(wsClientAtom);
  return ws ? new WorkspaceHostClient(ws) : null;
});
