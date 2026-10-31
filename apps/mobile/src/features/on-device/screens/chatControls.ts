import type { LocalModelSessionSnapshot } from '../models/session';
import { retryableLocalMessages, type LocalRunSnapshot } from '../runtime/agentLoop';
import { localAgentStatus, type LocalDownloadState } from '../runtime/status';
import type { LocalThread } from '../runtime/types';

export function localChatControls(
  thread: LocalThread,
  run: LocalRunSnapshot,
  model: LocalModelSessionSnapshot,
  workspaceActivity: string | null,
  download?: LocalDownloadState | null,
) {
  const active = run.phase !== 'idle';
  const ownRun = active && run.threadId === thread.id;
  const loading = model.phase === 'loading';
  const status = localAgentStatus({
    run,
    model,
    thread,
    modelId: thread.modelId,
    workspaceActivity,
    ...(download === undefined ? {} : { download }),
  });
  return {
    isLoading: active || loading,
    isStopping: ownRun && run.phase === 'stopping',
    showStopButton: ownRun,
    submitDisabled: active || loading || Boolean(workspaceActivity) || status.blocking,
    status: status.label,
    statusKind: status.kind,
    statusDetail: status.detail,
    progress: status.progress,
    approval: ownRun ? run.approval : null,
    canRetry: !active && !workspaceActivity && retryableLocalMessages(thread) !== null,
  };
}
