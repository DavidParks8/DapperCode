import { findLocalModelDefinition, localModelDisplayName } from '../models/catalog';
import type { LocalModelSessionSnapshot } from '../models/session';
import type { LocalRunSnapshot } from './agentLoop';
import type { LocalThread } from './types';

/** The subset of a model download snapshot that status and readiness depend on. */
export interface LocalDownloadState {
  phase: string;
  bytesWritten: number;
}

export interface LocalAgentStatusInput {
  run: LocalRunSnapshot;
  model: LocalModelSessionSnapshot;
  /** The conversation being shown, or null for a surface that is not a conversation. */
  thread: Pick<LocalThread, 'id' | 'status' | 'lastError'> | null;
  /** The model this surface uses: the conversation's model or the selected default. */
  modelId: string | null;
  /** That model's download state. Omit only when it is unknown; the download check is skipped. */
  download?: LocalDownloadState | null;
  workspaceActivity?: string | null;
}

export interface LocalAgentStatus {
  label: string;
  /** `busy` shows activity, `ready` is usable, `attention` needs a user step, `error` failed. */
  kind: 'busy' | 'ready' | 'attention' | 'error';
  /** 0–100 while a model loads or downloads, otherwise null. */
  progress: number | null;
  /** A longer explanation, such as the model or turn failure, to show beside the label. */
  detail: string | null;
  /** True when the model cannot be used at all until the user chooses or downloads one. */
  blocking: boolean;
}

export interface LocalConversationReadiness {
  canStart: boolean;
  /** Why a conversation cannot start yet; null when it can. */
  reason: string | null;
  action: 'choose-model' | 'download-model' | 'wait-for-download' | 'choose-workspace' | null;
}

function status(
  label: string,
  kind: LocalAgentStatus['kind'],
  extra: Partial<Omit<LocalAgentStatus, 'label' | 'kind'>> = {},
): LocalAgentStatus {
  return { label, kind, progress: null, detail: null, blocking: false, ...extra };
}

function percent(value: number): number {
  return Math.max(0, Math.min(100, Math.floor(value)));
}

/**
 * Maps run, model, download, and conversation state to a single user-facing status. A model that
 * is errored, missing, unsupported, or not downloaded is never reported as ready.
 */
export function localAgentStatus(input: LocalAgentStatusInput): LocalAgentStatus {
  const { run, model, thread, modelId } = input;
  if (input.workspaceActivity) {
    return status(input.workspaceActivity, 'busy');
  }
  if (run.phase !== 'idle') {
    if (thread && run.threadId !== thread.id) {
      return status('Another local conversation is running', 'busy');
    }
    return runStatus(run, model);
  }
  const modelStatus = residentModelStatus(model, modelId);
  if (modelStatus) {
    return modelStatus;
  }
  const blocked = modelAvailability(modelId, input.download);
  if (blocked) {
    return blocked;
  }
  if (thread?.status === 'interrupted') {
    return status('Stopped · completed edits are preserved', 'attention', {
      detail: thread.lastError,
    });
  }
  if (thread?.status === 'failed') {
    return status('Local turn failed', 'error', { detail: thread.lastError });
  }
  const name = localModelDisplayName(modelId ?? '');
  return model.phase === 'ready' && model.modelId === modelId
    ? status(`${name} · ready on this iPhone`, 'ready')
    : status(`${name} · loads when you send`, 'ready');
}

function runStatus(run: LocalRunSnapshot, model: LocalModelSessionSnapshot): LocalAgentStatus {
  switch (run.phase) {
    case 'stopping':
      return status(
        model.phase === 'loading'
          ? 'Cancelling model load…'
          : 'Stopping — waiting for current work to settle',
        'busy',
      );
    case 'approval':
      return status(
        `Waiting for your approval · ${run.approval?.summary ?? run.toolName ?? 'tool'}`,
        'attention',
      );
    case 'preparing':
      if (model.phase === 'loading') {
        return loading(model);
      }
      if (model.phase === 'stopping') {
        return status('Releasing the previous model…', 'busy');
      }
      return status('Preparing local turn', 'busy');
    case 'generating':
      return status('Generating on this iPhone', 'busy');
    case 'tool':
      return status(`Running ${run.toolName ?? 'local tool'}`, 'busy');
    case 'persisting':
      return status('Saving local conversation', 'busy');
    case 'idle':
      return status('Idle', 'ready');
  }
}

function loading(model: LocalModelSessionSnapshot): LocalAgentStatus {
  const progress = percent(model.progress);
  return status(`Loading ${localModelDisplayName(model.modelId ?? '')} · ${progress}%`, 'busy', {
    progress,
  });
}

function residentModelStatus(
  model: LocalModelSessionSnapshot,
  modelId: string | null,
): LocalAgentStatus | null {
  switch (model.phase) {
    case 'loading':
      return loading(model);
    case 'stopping':
      return status('Unloading model…', 'busy');
    case 'running':
      return status('Generating on this iPhone', 'busy');
    case 'error':
      return model.modelId === null || model.modelId === modelId
        ? status(
            model.modelId
              ? `Couldn't load ${localModelDisplayName(model.modelId)}`
              : 'The local model stopped responding',
            'error',
            { detail: model.error },
          )
        : null;
    case 'empty':
    case 'ready':
      return null;
  }
}

function modelAvailability(
  modelId: string | null,
  download: LocalDownloadState | null | undefined,
): LocalAgentStatus | null {
  if (!modelId) {
    return status('Choose a model', 'attention', { blocking: true });
  }
  const definition = findLocalModelDefinition(modelId);
  if (!definition) {
    return status('Model unavailable', 'error', {
      detail: 'This conversation’s model is no longer in the catalog. Choose another model.',
      blocking: true,
    });
  }
  const name = localModelDisplayName(modelId);
  if (definition.runtimeIssue) {
    return status(`${name} isn't supported in this build`, 'error', {
      detail: definition.runtimeIssue,
      blocking: true,
    });
  }
  if (download === undefined || download?.phase === 'ready') {
    return null;
  }
  return downloadStatus(name, definition.bytes, download);
}

function downloadStatus(
  name: string,
  bytes: number,
  download: LocalDownloadState | null,
): LocalAgentStatus {
  const progress = percent(((download?.bytesWritten ?? 0) / bytes) * 100);
  switch (download?.phase) {
    case 'downloading':
      return status(`Downloading ${name} · ${progress}%`, 'busy', { progress, blocking: true });
    case 'preparing':
      return status(`Preparing ${name} download…`, 'busy', { blocking: true });
    case 'verifying':
      return status(`Verifying ${name}…`, 'busy', { blocking: true });
    case 'loading':
      return status(`Checking ${name}…`, 'busy', { blocking: true });
    case 'paused':
      return status(`${name} download paused · ${progress}%`, 'attention', { blocking: true });
    case 'error':
      return status(`${name} download failed`, 'error', { blocking: true });
    default:
      return status(`${name} isn't downloaded`, 'attention', { blocking: true });
  }
}

/** Whether a new local conversation can start, with the reason and next step when it cannot. */
export function localConversationReadiness(input: {
  modelId: string | null;
  download: LocalDownloadState | null;
  workspaceId: string | null;
  workspaces: readonly { id: string }[];
}): LocalConversationReadiness {
  const definition = input.modelId ? findLocalModelDefinition(input.modelId) : null;
  if (!definition) {
    return {
      canStart: false,
      reason: input.modelId
        ? 'The selected model is no longer available. Choose another model.'
        : 'Choose a model to run on this iPhone.',
      action: 'choose-model',
    };
  }
  const name = localModelDisplayName(definition.id);
  if (definition.runtimeIssue) {
    return { canStart: false, reason: definition.runtimeIssue, action: 'choose-model' };
  }
  const phase = input.download?.phase ?? 'not_downloaded';
  if (['downloading', 'preparing', 'verifying', 'loading'].includes(phase)) {
    return {
      canStart: false,
      reason: `Wait for ${name} to finish downloading.`,
      action: 'wait-for-download',
    };
  }
  if (phase !== 'ready') {
    return {
      canStart: false,
      reason: `Download ${name} to start a conversation.`,
      action: 'download-model',
    };
  }
  if (!input.workspaceId || !input.workspaces.some((entry) => entry.id === input.workspaceId)) {
    return {
      canStart: false,
      reason: 'Choose or clone a workspace for the agent to work in.',
      action: 'choose-workspace',
    };
  }
  return { canStart: true, reason: null, action: null };
}
