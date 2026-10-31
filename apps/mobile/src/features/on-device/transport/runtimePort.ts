import { LOCAL_MODEL_CATALOG } from '../models/catalog';
import { GIT_TRANSFER_PROGRESS_EVENT } from '../native/services.types';
import type { OnDeviceRuntime } from '../runtime/runtime';
import type { OnDeviceRuntimeSlice } from '../runtime/types';
import type { LocalAgentPort, LocalModelChoice } from './port';

/**
 * The transport projects threads, the run (including approvals), and the resident model (load
 * progress shown as run activity). Download progress and other slices are read on demand, so they
 * never wake the event projector.
 */
const TRANSPORT_SLICES: readonly OnDeviceRuntimeSlice[] = ['threads', 'loop', 'models'];

function availableModels(runtime: OnDeviceRuntime) {
  return LOCAL_MODEL_CATALOG.filter(
    (model) => !model.runtimeIssue && runtime.downloads.snapshot(model.id).phase === 'ready',
  );
}

/**
 * Adapts the on-device runtime's public API to the transport port. Workspace mutations go through
 * `workspaceTask` so manual Git operations never interleave with an agent run.
 */
export function createRuntimeAgentPort(runtime: OnDeviceRuntime): LocalAgentPort {
  const native = runtime.native;
  return {
    subscribe: (listener) => runtime.subscribe(listener, TRANSPORT_SLICES),
    threads: () => runtime.threads.list(),
    thread: (id) => runtime.threads.find(id),
    run: () => runtime.loop.snapshot(),
    workspaces: () => runtime.workspaces(),
    refreshWorkspaces: () => runtime.refreshWorkspaces(),
    defaults: () => {
      const { workspaceId, modelId } = runtime.preferences();
      return { workspaceId, modelId };
    },
    availableModels: () => availableModels(runtime),
    modelChoices: () => {
      const session = runtime.models.snapshot();
      return availableModels(runtime).map((model): LocalModelChoice => {
        const resident = session.modelId === model.id;
        const loaded = resident && (session.phase === 'ready' || session.phase === 'running');
        const loading = resident && session.phase === 'loading';
        return {
          model,
          residency: loaded ? 'loaded' : loading ? 'loading' : 'idle',
          loadProgress: loading ? session.progress : 0,
          contextTokens: loaded ? session.contextTokens : null,
        };
      });
    },
    chooseModel: async (threadId, modelId) => {
      await runtime.chooseModel(modelId, threadId);
      return runtime.threads.get(threadId);
    },
    createThread: (workspaceId, modelId) => runtime.threads.create(workspaceId, modelId),
    updateThread: async (id, patch) => {
      const next = runtime.threads.change(id, (thread) => ({ ...thread, ...patch }));
      await runtime.threads.save(id);
      return next;
    },
    deleteThread: (id) => runtime.deleteThread(id),
    send: (id, text, submissionId, accepted) =>
      runtime.sendMessage(id, text, submissionId, accepted),
    stop: () => runtime.stop(),
    retryTurn: (id) => runtime.retryTurn(id),
    modelSession: () => runtime.models.snapshot(),
    resolveApproval: (callId, approved) => runtime.loop.resolveApproval(callId, approved),
    git: {
      status: (id) => native.getWorkspaceGitStatus(id),
      diff: (id) => native.getWorkspaceGitDiff(id, null),
      history: (id) => native.getWorkspaceGitHistory(id),
      branches: (id) => native.getWorkspaceGitBranches(id),
      stage: (id, path) =>
        runtime.workspaceTask('Staging changes', () => native.stageWorkspaceGit(id, path)),
      unstage: (id, path) =>
        runtime.workspaceTask('Unstaging changes', () => native.unstageWorkspaceGit(id, path)),
      commit: (id, message) =>
        runtime.workspaceTask('Committing', async () => {
          const author = runtime.preferences().author;
          if (!author) {
            throw new Error('Set your Git author name and email for On this iPhone first.');
          }
          await native.commitWorkspaceGit(id, message, author.name, author.email);
        }),
      switchBranch: (id, branch) =>
        runtime.workspaceTask('Switching branch', () =>
          native.switchWorkspaceGitBranch(id, branch),
        ),
      push: (id) => runtime.workspaceTask('Pushing', () => runtime.pushWorkspace(id)),
      fetch: (id) =>
        runtime.workspaceTask('Fetching', async () => {
          runtime.requireNetwork('fetch');
          await native.fetchWorkspaceGit(id, await runtime.credential(id));
        }),
      pull: (id) =>
        runtime.workspaceTask('Pulling', async () => {
          runtime.requireNetwork('pull');
          return native.pullWorkspaceGit(id, await runtime.credential(id));
        }),
      init: (id, branch, origin) =>
        runtime.workspaceTask('Initializing Git', () =>
          native.initWorkspaceGit(id, branch, origin).finally(() => runtime.refreshWorkspaces()),
        ),
      discard: (id, path, removeUntracked) =>
        runtime.workspaceTask('Discarding changes', () =>
          native.discardWorkspaceGit(id, path, removeUntracked),
        ),
      createBranch: (id, name) =>
        runtime.workspaceTask('Creating branch', () =>
          native.createWorkspaceGitBranch(id, name, true),
        ),
    },
    workspaceAdmin: {
      create: (name) => runtime.createWorkspace(name),
      select: (id) => runtime.selectWorkspace(id),
      rename: (id, name) => runtime.workspaceAdmin.rename(id, name),
      delete: (id) => runtime.workspaceAdmin.delete(id),
      clone: (name, url) => runtime.cloneWorkspace(name, url),
      cloneProgress: () => native.getGitTransferProgress(),
      onCloneProgress: (listener) => {
        const subscription = native.addListener(GIT_TRANSFER_PROGRESS_EVENT, listener);
        return () => subscription.remove();
      },
      cancelTransfer: () => native.cancelGitTransfer(),
      changeToken: (id) => native.getWorkspaceChangeToken(id),
      metadata: async (id) => {
        const [branches, origin] = await Promise.allSettled([
          native.getWorkspaceGitBranches(id),
          native.getWorkspaceGitOrigin(id),
        ]);
        return {
          branch:
            branches.status === 'fulfilled'
              ? (branches.value.current ??
                branches.value.branches.find((branch) => branch.current)?.name ??
                null)
              : null,
          origin: origin.status === 'fulfilled' ? origin.value : null,
        };
      },
    },
    files: {
      list: (id, path, limit) => native.listWorkspaceFiles(id, path, limit),
      read: (id, path, offset, limit) => native.readWorkspaceFile(id, path, offset, limit),
      write: (id, path, content, revision) =>
        runtime.workspaceTask('Saving file', () =>
          native.writeWorkspaceFile(id, path, content, revision),
        ),
      rename: (id, path, destination) =>
        runtime.workspaceTask('Renaming', () => native.renameWorkspaceEntry(id, path, destination)),
      remove: (id, path) =>
        runtime.workspaceTask('Deleting', () => native.removeWorkspaceEntry(id, path)),
    },
    network: () => runtime.network(),
  };
}
