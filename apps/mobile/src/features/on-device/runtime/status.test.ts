import type { LocalModelSessionSnapshot } from '../models/session';
import type { LocalRunSnapshot } from './agentLoop';
import { localAgentStatus, localConversationReadiness } from './status';

const modelId = 'qwen3-1.7b-q4-k-m';
const idle: LocalRunSnapshot = {
  phase: 'idle',
  threadId: null,
  turnId: null,
  toolName: null,
  approval: null,
};
const empty: LocalModelSessionSnapshot = {
  phase: 'empty',
  modelId: null,
  progress: 0,
  error: null,
  contextTokens: null,
};
const ready: LocalModelSessionSnapshot = {
  phase: 'ready',
  modelId,
  progress: 100,
  error: null,
  contextTokens: 8192,
};
const thread = { id: 'thread', status: 'complete' as const, lastError: null };
const downloaded = { phase: 'ready', bytesWritten: 0 };

function label(
  overrides: Partial<Parameters<typeof localAgentStatus>[0]> = {},
): ReturnType<typeof localAgentStatus> {
  return localAgentStatus({
    run: idle,
    model: empty,
    thread,
    modelId,
    download: downloaded,
    ...overrides,
  });
}

test('an errored, missing, unsupported, or undownloaded model is never reported as ready', () => {
  const errored = label({
    model: { ...empty, phase: 'error', modelId, error: 'Download and verify this model.' },
  });
  expect(errored).toMatchObject({
    label: "Couldn't load Qwen3 1.7B Q4_K_M",
    kind: 'error',
    detail: 'Download and verify this model.',
  });
  expect(label({ download: { phase: 'not_downloaded', bytesWritten: 0 } })).toMatchObject({
    label: "Qwen3 1.7B Q4_K_M isn't downloaded",
    kind: 'attention',
    blocking: true,
  });
  expect(label({ modelId: 'removed-model' })).toMatchObject({ kind: 'error', blocking: true });
  expect(label({ modelId: 'bonsai-2-2b-pq2-0' })).toMatchObject({ kind: 'error', blocking: true });
  expect(label({ modelId: null })).toMatchObject({ label: 'Choose a model', blocking: true });
  for (const status of [
    errored,
    label({ download: { phase: 'paused', bytesWritten: 1 } }),
    label({ modelId: null }),
  ]) {
    expect(status.label).not.toMatch(/ready/i);
  }
});

test('a different model’s error does not mark this conversation as failed', () => {
  expect(
    label({ model: { ...empty, phase: 'error', modelId: 'qwen3-4b-q4-k-m', error: 'x' } }).kind,
  ).toBe('ready');
});

test('ready states distinguish a loaded model from one that loads on send', () => {
  expect(label({ model: ready })).toMatchObject({
    label: 'Qwen3 1.7B Q4_K_M · ready on this iPhone',
    kind: 'ready',
  });
  expect(label()).toMatchObject({
    label: 'Qwen3 1.7B Q4_K_M · loads when you send',
    kind: 'ready',
  });
});

test('every run and model phase has a user-facing label, including load progress during a send', () => {
  const run = (phase: LocalRunSnapshot['phase'], extra: Partial<LocalRunSnapshot> = {}) => ({
    ...idle,
    phase,
    threadId: 'thread',
    turnId: 'turn',
    ...extra,
  });
  const loading = { ...empty, phase: 'loading' as const, modelId, progress: 42.7 };
  expect(label({ run: run('preparing'), model: loading })).toMatchObject({
    label: 'Loading Qwen3 1.7B Q4_K_M · 42%',
    progress: 42,
    kind: 'busy',
  });
  expect(label({ run: run('preparing'), model: ready }).label).toBe('Preparing local turn');
  expect(label({ run: run('generating'), model: ready }).label).toBe('Generating on this iPhone');
  expect(label({ run: run('tool', { toolName: 'read_file' }) }).label).toBe('Running read_file');
  expect(label({ run: run('stopping'), model: loading }).label).toBe('Cancelling model load…');
  expect(label({ run: run('stopping'), model: ready }).label).toContain('Stopping');
  expect(label({ run: run('persisting') }).label).toBe('Saving local conversation');
  expect(
    label({
      run: run('approval', {
        toolName: 'git_push',
        approval: {
          threadId: 'thread',
          turnId: 'turn',
          callId: 'call',
          toolName: 'git_push',
          summary: 'Push the current branch to its remote',
        },
      }),
    }),
  ).toMatchObject({
    label: 'Waiting for your approval · Push the current branch to its remote',
    kind: 'attention',
  });
  expect(label({ run: run('generating', { threadId: 'other' }) }).label).toBe(
    'Another local conversation is running',
  );
  expect(label({ model: loading })).toMatchObject({ label: 'Loading Qwen3 1.7B Q4_K_M · 42%' });
  expect(label({ model: { ...ready, phase: 'stopping' } }).label).toBe('Unloading model…');
  expect(label({ model: { ...ready, phase: 'running' } }).label).toBe('Generating on this iPhone');
  expect(label({ workspaceActivity: 'Pushing' }).label).toBe('Pushing');
});

test('settled conversation failures surface their detail', () => {
  expect(
    label({ thread: { ...thread, status: 'failed', lastError: 'Context full' } }),
  ).toMatchObject({ label: 'Local turn failed', kind: 'error', detail: 'Context full' });
  expect(label({ thread: { ...thread, status: 'interrupted', lastError: null } })).toMatchObject({
    label: 'Stopped · completed edits are preserved',
    kind: 'attention',
  });
});

test('readiness explains exactly why a new conversation cannot start', () => {
  const workspaces = [{ id: 'workspace' }];
  const base = { modelId, download: downloaded, workspaceId: 'workspace', workspaces };
  expect(localConversationReadiness(base)).toEqual({ canStart: true, reason: null, action: null });
  expect(localConversationReadiness({ ...base, modelId: null })).toMatchObject({
    canStart: false,
    action: 'choose-model',
    reason: 'Choose a model to run on this iPhone.',
  });
  expect(
    localConversationReadiness({ ...base, download: { phase: 'not_downloaded', bytesWritten: 0 } }),
  ).toMatchObject({ canStart: false, action: 'download-model' });
  expect(
    localConversationReadiness({ ...base, download: { phase: 'downloading', bytesWritten: 9 } }),
  ).toMatchObject({ canStart: false, action: 'wait-for-download' });
  expect(localConversationReadiness({ ...base, workspaceId: 'deleted' })).toMatchObject({
    canStart: false,
    action: 'choose-workspace',
  });
  // A model that has not been loaded yet is enough; it loads on the first send.
  expect(localConversationReadiness(base).canStart).toBe(true);
});
