import type { LocalModelSessionSnapshot } from '../models/session';
import type { LocalRunSnapshot } from '../runtime/agentLoop';
import type { LocalThread } from '../runtime/types';

export function localChatControls(
  thread: LocalThread,
  run: LocalRunSnapshot,
  model: LocalModelSessionSnapshot,
  workspaceActivity: string | null,
) {
  const active = run.phase !== 'idle';
  const ownRun = active && run.threadId === thread.id;
  const loading = model.phase === 'loading';
  const status = workspaceActivity ?? runStatus(thread.id, run) ?? settledStatus(thread, model);
  return {
    isLoading: active || loading,
    isStopping: ownRun && run.phase === 'stopping',
    showStopButton: ownRun,
    submitDisabled: active || loading || Boolean(workspaceActivity),
    status,
  };
}

function runStatus(threadId: string, run: LocalRunSnapshot): string | null {
  if (run.phase !== 'idle' && run.threadId !== threadId) {
    return 'Another local conversation is running';
  }
  switch (run.phase) {
    case 'idle':
      return null;
    case 'stopping':
      return 'Stopping — waiting for current work to settle';
    case 'persisting':
      return 'Saving local conversation';
    case 'tool':
      return `Running ${run.toolName ?? 'local tool'}`;
    case 'preparing':
      return 'Preparing local turn';
    case 'generating':
      return 'Generating on this iPhone';
  }
}

function settledStatus(thread: LocalThread, model: LocalModelSessionSnapshot): string {
  if (model.phase === 'loading') {
    return `Loading model · ${Math.round(model.progress)}%`;
  }
  if (thread.status === 'interrupted') {
    return 'Stopped · completed edits are preserved';
  }
  if (thread.status === 'failed') {
    return 'Local turn failed';
  }
  return 'On this iPhone · offline ready';
}
