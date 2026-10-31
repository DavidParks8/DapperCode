import { GitHubAuthStrategy } from '../auth/github';
import type { GitDeviceAuthorization } from '../auth/strategy';
import { gitToolApproval } from '../git/gitTools';
import type { LocalGitIdentity } from '../git/gitTools';
import { LOCAL_MODEL_CATALOG, localModelDefinition } from '../models/catalog';
import { ModelDownloadController, type ModelDownloadSnapshot } from '../models/downloads';
import { loadNativeModelContext } from '../models/engine';
import { LocalModelSession } from '../models/session';
import type { OnDeviceNativeServices } from '../native/services.types';
import type { LocalWorkspace } from '../workspaces/types';
import { LocalAgentLoop } from './agentLoop';
import { LocalDraftStore, type LocalDraftRestore } from './drafts';
import { RuntimeSliceEmitter } from './emitter';
import { LOCAL_TOOL_DEFINITIONS, localToolExecutor } from './localTools';
import { NetworkMonitor, unknownNetwork, type OnDeviceNetworkPort } from './network';
import {
  recoveryNotices,
  RuntimeIssueLog,
  throwFirstRejection,
  persistenceFailures,
} from './issues';
import { LocalPreferencesStore } from './preferences';
import { ModelResidency } from './residency';
import type { LocalPreferences } from './preferences';
import { LocalThreadRepository } from './threads';
import type {
  LocalThread,
  OnDeviceIssue,
  OnDeviceReachability,
  OnDeviceRuntimeSlice,
} from './types';
import { LocalWorkspaceAdmin } from './workspaceAdmin';

export interface OnDeviceRuntimeOptions {
  /** Platform reachability observer; defaults to `unknown`, which never pre-empts actions. */
  network?: OnDeviceNetworkPort;
  /** Minimum spacing between renders caused by token streaming, load and download progress. */
  emitIntervalMs?: number;
  /** Delay for coalescing non-journal conversation writes during a run. */
  threadProgressDelayMs?: number;
  /** Typing pause before a conversation's draft is saved. */
  draftDelayMs?: number;
}

type SuspensionMode = 'background' | 'memory' | 'dispose';

export class OnDeviceRuntime {
  readonly threads: LocalThreadRepository;
  readonly models: LocalModelSession;
  readonly downloads: ModelDownloadController;
  readonly loop: LocalAgentLoop;
  readonly authentication: GitHubAuthStrategy;
  private readonly githubClientId =
    process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID?.trim() ?? 'Ov23ctzKpdigHwQUbG8X';
  private readonly emitter: RuntimeSliceEmitter;
  private readonly drafts: LocalDraftStore;
  private readonly networkMonitor: NetworkMonitor;
  private readonly settings: LocalPreferencesStore;
  readonly workspaceAdmin: LocalWorkspaceAdmin;
  private readonly issueLog: RuntimeIssueLog;
  private workspaceValues: LocalWorkspace[] = [];
  private initialization: Promise<void> | null = null;
  private suspension: Promise<void> | null = null;
  private suspensionMode: SuspensionMode | null = null;
  private backgrounded = false;
  private readonly residency: ModelResidency;
  private disposal: Promise<void> | null = null;
  private disposing = false;
  private workspaceOperation: Promise<unknown> | null = null;
  private workspaceOperationLabel: string | null = null;

  constructor(
    readonly native: OnDeviceNativeServices,
    options: OnDeviceRuntimeOptions = {},
  ) {
    this.emitter = new RuntimeSliceEmitter(options.emitIntervalMs);
    this.networkMonitor = new NetworkMonitor(options.network ?? unknownNetwork, (value) => {
      this.emitter.emit('network');
      if (value !== 'offline') {
        this.resumeLifecycleDownload();
      }
    });
    this.issueLog = new RuntimeIssueLog(
      () =>
        persistenceFailures(
          this.settings.failure(),
          this.drafts.failure(),
          this.threads.persistenceFailures(),
        ),
      () => this.emitter.emit('issues'),
    );
    this.settings = new LocalPreferencesStore(native, (kind) =>
      kind === 'value' ? this.emitter.emit('preferences') : this.issueLog.invalidate(),
    );
    this.workspaceAdmin = new LocalWorkspaceAdmin(this, this.settings);
    this.threads = new LocalThreadRepository(
      native,
      (change) => {
        if (change === 'content') {
          this.emitter.coalesce('threads');
        } else {
          this.emitter.emit('threads');
          this.issueLog.invalidate();
        }
      },
      options.threadProgressDelayMs,
    );
    this.drafts = new LocalDraftStore(
      native,
      () => this.issueLog.invalidate(),
      options.draftDelayMs,
    );
    this.models = new LocalModelSession(native, loadNativeModelContext, () =>
      this.emitter.coalesce('models'),
    );
    this.downloads = new ModelDownloadController(LOCAL_MODEL_CATALOG, native, () =>
      this.emitter.coalesce('downloads'),
    );
    this.authentication = new GitHubAuthStrategy({
      clientId: this.githubClientId,
      credentials: {
        store: ({ host, accountId, username, token }) =>
          native.storeGitCredential(host, accountId, username, token),
        remove: (reference) => native.removeGitCredential(reference),
      },
    });
    this.loop = new LocalAgentLoop(
      this.threads,
      this.models,
      LOCAL_TOOL_DEFINITIONS,
      localToolExecutor(
        native,
        () => this.settings.get().author,
        (id) => this.credential(id),
      ),
      () => this.emitter.emit('loop'),
      gitToolApproval,
    );
    this.residency = new ModelResidency({
      models: this.models,
      downloads: this.downloads,
      idle: () => this.loop.snapshot().phase === 'idle',
      memory: () => native.getMemoryInfo(),
    });
  }

  /** Subscribes to the given slices (all by default); unrelated changes do not notify. */
  subscribe = (listener: () => void, slices?: readonly OnDeviceRuntimeSlice[]): (() => void) =>
    this.emitter.subscribe(listener, slices);

  /** A number that changes whenever any of the given slices (all by default) changes. */
  version = (slices?: readonly OnDeviceRuntimeSlice[]): number => this.emitter.version(slices);

  preferences(): LocalPreferences {
    return this.settings.get();
  }
  workspaces(): readonly LocalWorkspace[] {
    return this.workspaceValues;
  }
  network(): OnDeviceReachability {
    return this.networkMonitor.current();
  }
  authConfigured(): boolean {
    return Boolean(this.githubClientId);
  }
  workspaceActivity(): string | null {
    return this.workspaceOperationLabel;
  }
  workspaceBusy(): boolean {
    return this.workspaceOperation !== null || this.loop.snapshot().phase !== 'idle';
  }

  /** Throws a friendly `OnDeviceOfflineError` when the device is known to be offline. */
  requireNetwork(action: string): void {
    this.networkMonitor.require(action);
  }

  /** Every current problem, persistence first. The array is stable until the issues change. */
  issues(): readonly OnDeviceIssue[] {
    return this.issueLog.list();
  }

  /** The most important current issue, for screens that show a single message. */
  error(): Error | null {
    const first = this.issues()[0];
    return first ? new Error(first.message) : null;
  }

  /** Records a transient, dismissible operation failure. */
  report(error: unknown, threadId: string | null = null): void {
    this.issueLog.report(error, threadId);
  }

  /** Hides one issue. A dismissed persistence failure reappears if a later write fails again. */
  dismissIssue(id: string): void {
    this.issueLog.dismiss(id);
  }

  /** Dismisses every operation and recovery notice. */
  dismissError(): void {
    this.issueLog.dismissTransient();
  }

  /** Clears a settled conversation's last error and its operation issues. */
  async dismissThreadError(threadId: string): Promise<void> {
    this.issueLog.dismissThread(threadId);
    const thread = this.threads.get(threadId);
    if (thread.lastError && thread.status !== 'running') {
      this.threads.change(threadId, (current) => ({ ...current, lastError: null }));
      await this.threads.save(threadId);
    }
  }

  /** Rewrites every conversation, setting, and draft whose last write failed. */
  async retryPersistence(): Promise<void> {
    this.issueLog.restoreDismissed();
    try {
      await this.persist(this.threads.retryPersistence());
    } finally {
      this.issueLog.invalidate();
    }
  }

  async stop(): Promise<void> {
    this.native.cancelGitTransfer();
    await this.loop.stop();
  }

  workspaceTask<T>(label: string, action: () => Promise<T>): Promise<T> {
    if (this.workspaceOperation || this.loop.snapshot().phase !== 'idle') {
      return Promise.reject(new Error('Wait for the active workspace operation to settle.'));
    }
    this.workspaceOperationLabel = label;
    const task = Promise.resolve()
      .then(action)
      .finally(() => {
        this.workspaceOperation = null;
        this.workspaceOperationLabel = null;
        this.emitter.emit('workspaces');
      });
    this.workspaceOperation = task;
    this.emitter.emit('workspaces');
    return task;
  }

  async sendMessage(
    id: string,
    text: string,
    submissionId: string,
    accepted: () => void,
  ): Promise<LocalThread> {
    await this.residency.settled();
    if (this.workspaceOperation || this.suspension || this.disposal) {
      throw new Error('Wait for on-device operations to settle before sending.');
    }
    return this.loop.send(id, text, submissionId, accepted);
  }

  async retryTurn(id: string): Promise<LocalThread> {
    await this.residency.settled();
    if (this.workspaceOperation || this.suspension || this.disposal) {
      throw new Error('Wait for on-device operations to settle before retrying.');
    }
    return this.loop.retry(id);
  }

  initialize(): Promise<void> {
    this.initialization ??= this.restore().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  /** Startup; each step stops early once disposal has begun so it never races a new owner. */
  private async restore(): Promise<void> {
    const settings = await this.settings.restore();
    if (settings.notice) {
      this.issueLog.recover(settings.notice);
    }
    if (this.disposing) {
      return;
    }
    await this.threads.initialize();
    if (this.disposing) {
      return;
    }
    const known = new Set(this.threads.list().map((thread) => thread.id));
    let drafts: LocalDraftRestore = { setAside: 0, leftInPlace: 0 };
    try {
      drafts = await this.drafts.restore(
        known,
        this.threads.recovery().ids,
        this.settings.pendingLegacyDrafts(),
        (threadId) => this.settings.settleLegacyDraft(threadId),
      );
    } catch (error) {
      this.report(error);
    }
    if (this.disposing) {
      return;
    }
    await this.settings.flush().catch(() => undefined);
    for (const notice of recoveryNotices(this.threads.recovery(), drafts)) {
      this.issueLog.recover(notice);
    }
    await this.refreshWorkspaces().catch((error: unknown) => this.report(error));
    await this.networkMonitor.start();
    await Promise.allSettled(LOCAL_MODEL_CATALOG.map((model) => this.downloads.inspect(model.id)));
    this.emitter.emit('threads', 'models', 'downloads', 'preferences', 'workspaces', 'issues');
  }

  async createWorkspace(name: string): Promise<LocalWorkspace> {
    const workspace = await this.native.createWorkspace(name);
    await this.refreshWorkspaces();
    await this.selectWorkspace(workspace.id);
    return workspace;
  }

  async refreshWorkspaces(): Promise<void> {
    this.workspaceValues = await this.native.listWorkspaces();
    this.emitter.emit('workspaces');
  }

  async cloneWorkspace(name: string, url: string): Promise<LocalWorkspace> {
    this.requireNetwork('clone repositories');
    const account = this.settings.get().account;
    const parsed = new URL(url);
    const reference =
      account?.host === parsed.hostname
        ? this.authentication.resolveCredential(account, url)
        : null;
    return this.workspaceTask('Cloning repository', async () => {
      const workspace = await this.native.cloneWorkspace(name, url, reference);
      await this.refreshWorkspaces();
      await this.selectWorkspace(workspace.id);
      return workspace;
    });
  }

  /** Pushes the workspace's current branch with the signed-in account's credential. */
  async pushWorkspace(workspaceId: string): Promise<void> {
    this.requireNetwork('push');
    await this.native.pushWorkspaceGit(workspaceId, await this.credential(workspaceId));
  }

  /** Chooses the workspace for new conversations; never interrupts a running conversation. */
  async selectWorkspace(id: string, threadId?: string): Promise<void> {
    if (!this.workspaceValues.some((entry) => entry.id === id)) {
      throw new Error('Choose an available local workspace.');
    }
    if (threadId && this.threads.get(threadId).messages.length > 0) {
      throw new Error('Start a new conversation to change its workspace.');
    }
    this.settings.update({ workspaceId: id });
    if (threadId) {
      this.threads.change(threadId, (thread) => ({ ...thread, workspaceId: id }));
      await this.threads.save(threadId);
    }
    await this.settings.save();
  }

  /**
   * Selects (and loads, when needed) a model. Rejects instead of interrupting a running
   * conversation when the change would replace the model that run is using.
   */
  async selectModel(id: string, threadId?: string): Promise<void> {
    localModelDefinition(id);
    if (threadId && this.isRunning(threadId)) {
      throw new Error('Stop this conversation before changing its model.');
    }
    await this.residency.settled();
    const loaded = this.models.snapshot();
    if (loaded.modelId !== id || (loaded.phase !== 'ready' && loaded.phase !== 'running')) {
      if (this.loop.snapshot().phase !== 'idle') {
        throw new Error(
          'A local conversation is running. Stop it or wait for it to finish before loading another model.',
        );
      }
      await this.residency.transition(() => this.models.load(id));
    }
    await this.chooseModel(id, threadId);
  }

  /**
   * Uses a downloaded model for a conversation (when given) and for new conversations without
   * loading it; it loads when that conversation next sends. Rejects while the conversation runs.
   */
  async chooseModel(id: string, threadId?: string): Promise<void> {
    localModelDefinition(id);
    if (threadId && this.isRunning(threadId)) {
      throw new Error('Stop this conversation before changing its model.');
    }
    this.settings.update({ modelId: id });
    if (threadId) {
      this.threads.change(threadId, (thread) => ({ ...thread, modelId: id }));
      await this.threads.save(threadId);
    }
    await this.settings.save();
  }

  /** Releases the loaded model; rejects while a conversation is using it. */
  async unloadModel(): Promise<void> {
    if (this.loop.snapshot().phase !== 'idle') {
      throw new Error('Stop the running local conversation before unloading its model.');
    }
    this.residency.forget();
    await this.residency.transition(() => this.models.unload());
  }

  /** Deletes a download. Unrelated downloads never interrupt a running conversation. */
  async removeModel(id: string): Promise<void> {
    localModelDefinition(id);
    const run = this.loop.snapshot();
    const loaded = this.models.snapshot().modelId === id;
    const used = run.threadId ? this.threads.find(run.threadId)?.modelId === id : false;
    if (run.phase !== 'idle' && (loaded || used)) {
      throw new Error('Stop the running local conversation before deleting the model it uses.');
    }
    this.residency.forget(id);
    if (loaded) {
      await this.residency.transition(() => this.models.unload());
    }
    await this.downloads.remove(id);
    if (this.settings.get().modelId === id) {
      this.settings.update({ modelId: null });
      await this.settings.save();
    }
  }

  /** Starts a catalog download, failing fast with a friendly message while offline. */
  async downloadModel(id: string): Promise<ModelDownloadSnapshot> {
    this.requireNetwork('download models');
    return this.downloads.download(id);
  }

  async resumeModelDownload(id: string): Promise<ModelDownloadSnapshot> {
    this.requireNetwork('download models');
    this.residency.forget(id);
    return this.downloads.resume(id);
  }

  async createThread(): Promise<LocalThread> {
    const { modelId, workspaceId } = this.settings.get();
    if (!modelId || !workspaceId) {
      throw new Error('Choose a downloaded model and a local workspace first.');
    }
    return this.threads.create(workspaceId, modelId);
  }

  /** Deletes a conversation together with its saved draft. */
  async deleteThread(id: string): Promise<void> {
    await this.threads.remove(id);
    this.issueLog.dismissThread(id);
    this.settings.settleLegacyDraft(id);
    await this.drafts.remove(id);
  }

  draft(id: string): string {
    return this.drafts.get(id);
  }

  setDraft(id: string, text: string): void {
    this.drafts.set(id, text);
  }

  async saveAuthor(author: LocalGitIdentity): Promise<void> {
    if (!author.name.trim() || !author.email.trim()) {
      throw new Error('Enter a Git author name and email.');
    }
    this.settings.update({ author: { name: author.name.trim(), email: author.email.trim() } });
    await this.settings.save();
  }

  async signIn(presentCode: (value: GitDeviceAuthorization) => Promise<void>): Promise<void> {
    this.requireNetwork('sign in to GitHub');
    const account = await this.authentication.signIn(presentCode);
    this.settings.update({
      account,
      author: this.settings.get().author ?? {
        name: account.login,
        email: `${account.id}+${account.login}@users.noreply.github.com`,
      },
    });
    await this.settings.save();
  }

  /** Removes the credential; rejects only while a Git transfer might be using it. */
  async signOut(): Promise<void> {
    if (this.workspaceOperation || this.native.getGitTransferProgress().active) {
      throw new Error('Wait for the active Git transfer to finish before signing out.');
    }
    const account = this.settings.get().account;
    if (account) {
      await this.authentication.signOut(account);
    }
    this.settings.update({ account: null });
    await this.settings.save();
  }

  async credential(workspaceId: string): Promise<string | null> {
    const account = this.settings.get().account;
    if (!account) {
      return null;
    }
    return this.authentication.resolveCredential(
      account,
      await this.native.getWorkspaceGitOrigin(workspaceId),
    );
  }

  /**
   * The app moved to the background: stops local work, unloads the model, and flushes state.
   * Model downloads keep running in their background URL session.
   */
  background(): Promise<void> {
    this.backgrounded = true;
    return this.suspendFor('background');
  }

  /** Low memory: stops local work and unloads the model without pausing downloads. */
  relieveMemory(): Promise<void> {
    return this.suspendFor('memory');
  }

  /**
   * The app is active (after startup or a return from the background): re-attaches downloads and,
   * once online, continues transfers or verification the system interrupted, then warms
   * the previously loaded model if memory admits it. Interrupted turns are never replayed.
   */
  async foreground(): Promise<void> {
    this.backgrounded = false;
    if (this.suspension) {
      await Promise.allSettled([this.suspension]);
    }
    if (this.disposal || this.backgrounded) {
      return;
    }
    this.resumeLifecycleDownload();
    await this.residency.warm();
  }

  dispose(): Promise<void> {
    this.disposing = true;
    this.authentication.cancelSignIn();
    this.disposal ??= this.finishDisposal();
    return this.disposal;
  }

  private async finishDisposal(): Promise<void> {
    if (this.initialization) {
      await Promise.allSettled([this.initialization]);
    }
    const previous = this.suspension ? await Promise.allSettled([this.suspension]) : [];
    try {
      await this.suspend('dispose');
      throwFirstRejection(previous);
    } finally {
      this.networkMonitor.close();
      this.drafts.close();
      this.threads.close();
      this.emitter.close();
    }
  }

  private suspendFor(mode: 'background' | 'memory'): Promise<void> {
    if (this.suspension && (this.suspensionMode === 'background' || this.suspensionMode === mode)) {
      return this.suspension;
    }
    const previous = this.suspension;
    const task = (async () => {
      if (previous) {
        await Promise.allSettled([previous]);
      }
      await this.suspend(mode);
    })();
    const tracked = task.finally(() => {
      if (this.suspension === tracked) {
        this.suspension = null;
        this.suspensionMode = null;
      }
    });
    this.suspension = tracked;
    this.suspensionMode = mode;
    return tracked;
  }

  private async suspend(mode: SuspensionMode): Promise<void> {
    if (mode === 'background') {
      this.residency.rememberForBackground();
    } else {
      this.residency.forget();
    }
    if (mode !== 'memory') {
      this.native.cancelGitTransfer();
    }
    const stopping = await Promise.allSettled([this.loop.stop()]);
    const workspace =
      mode !== 'memory' && this.workspaceOperation
        ? await Promise.allSettled([this.workspaceOperation])
        : [];
    // Model downloads run in a background URL session and are never paused by the lifecycle;
    // disposal only stops progress polling, and a later runtime re-attaches them.
    if (mode === 'dispose') {
      this.downloads.dispose();
    }
    const results = await Promise.allSettled([
      mode === 'dispose' ? this.models.dispose() : this.models.unload(),
      this.flush(),
    ]);
    throwFirstRejection([...stopping, ...workspace, ...results]);
  }

  private resumeLifecycleDownload(): void {
    if (
      !this.backgrounded &&
      !this.suspension &&
      !this.disposal &&
      this.networkMonitor.current() !== 'offline'
    ) {
      void this.downloads.resumeLifecyclePaused().catch((error: unknown) => this.report(error));
    }
  }

  private isRunning(threadId: string): boolean {
    const run = this.loop.snapshot();
    return (
      (run.phase !== 'idle' && run.threadId === threadId) ||
      this.threads.find(threadId)?.status === 'running'
    );
  }

  /** Writes settings, drafts, and conversation progress that has not been saved yet. */
  flush(): Promise<void> {
    return this.persist(this.threads.flush());
  }

  private async persist(threads: Promise<void>): Promise<void> {
    const stores = await Promise.allSettled([this.drafts.flush(), threads]);
    // Settings follow drafts so confirmed legacy inline drafts are dropped in the same pass.
    throwFirstRejection([...stores, ...(await Promise.allSettled([this.settings.flush()]))]);
  }
}
