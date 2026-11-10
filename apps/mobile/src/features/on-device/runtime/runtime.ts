import type { GitHubAuthStrategy } from '../auth/github';
import type { GitDeviceAuthorization } from '../auth/strategy';
import type { LocalGitIdentity } from '../git/gitTools';
import { LOCAL_MODEL_CATALOG } from '../models/catalog';
import { ModelDownloadController, type ModelDownloadSnapshot } from '../models/downloads';
import { loadNativeModelContext } from '../models/engine';
import { LocalModelSession } from '../models/session';
import type { OnDeviceNativeServices } from '../native/services.types';
import type { LocalWorkspace } from '../workspaces/types';
import { LocalAgentLoop } from './agentLoop';
import { LegacyDraftReader, type LegacyDraftOutcome, type LocalDraftRestore } from './drafts';
import { RuntimeSliceEmitter } from './emitter';
import { LocalGitAccount } from './gitAccount';
import * as localTools from './localTools';
import { NetworkMonitor, unknownNetwork, type OnDeviceNetworkPort } from './network';
import {
  recoveryNotices,
  supersededDraftNotice,
  RuntimeIssueLog,
  throwFirstRejection,
  persistenceFailures,
} from './issues';
import { LocalPreferencesStore, type LocalPreferences } from './preferences';
import { ModelResidency } from './residency';
import {
  LocalRunActivities,
  LOCAL_RUN_EXPIRED_MESSAGE,
  localRunActivitySubtitle,
} from './runActivity';
import { LocalModelSelection } from './modelSelection';
import { LocalSkills } from './skills';
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
  /** Interval between progress reports that keep a background run's native activity alive. */
  runHeartbeatMs?: number;
}

type SuspensionMode = 'background' | 'memory' | 'dispose';

export class OnDeviceRuntime {
  readonly threads: LocalThreadRepository;
  readonly models: LocalModelSession;
  readonly downloads: ModelDownloadController;
  readonly loop: LocalAgentLoop;
  readonly authentication: GitHubAuthStrategy;
  private readonly gitAccount: LocalGitAccount;
  private readonly emitter: RuntimeSliceEmitter;
  private readonly drafts: LegacyDraftReader;
  private readonly networkMonitor: NetworkMonitor;
  private readonly settings: LocalPreferencesStore;
  readonly workspaceAdmin: LocalWorkspaceAdmin;
  /**
   * Copilot + OpenCode Agent Skills: listing, personal import/remove, permissions and the global
   * switch, HTTPS catalogs (downloaded only on request), and slash commands.
   */
  readonly skills: LocalSkills;
  private readonly issueLog: RuntimeIssueLog;
  private workspaceValues: LocalWorkspace[] = [];
  private initialization: Promise<void> | null = null;
  private suspension: Promise<void> | null = null;
  private suspensionMode: SuspensionMode | null = null;
  private backgrounded = false;
  private readonly residency: ModelResidency;
  private readonly runActivity: LocalRunActivities;
  private disposal: Promise<void> | null = null;
  private disposing = false;
  private workspaceOperation: Promise<unknown> | null = null;
  private workspaceOperationLabel: string | null = null;
  private readonly modelSelection: LocalModelSelection;

  constructor(
    readonly native: OnDeviceNativeServices,
    options: OnDeviceRuntimeOptions = {},
  ) {
    this.emitter = new RuntimeSliceEmitter(options.emitIntervalMs);
    this.runActivity = new LocalRunActivities(
      native,
      {
        subtitle: () => localRunActivitySubtitle(this.loop.snapshot()),
        expired: () => this.expireRun(),
        // A turn that settles in the background releases the model before giving the time back.
        settled: () =>
          this.backgrounded && !this.disposal
            ? this.suspendFor('background').catch((error: unknown) => this.report(error))
            : null,
      },
      options.runHeartbeatMs,
    );
    this.networkMonitor = new NetworkMonitor(options.network ?? unknownNetwork, (value) => {
      this.emitter.emit('network');
      if (value !== 'offline') {
        this.resumeLifecycleDownload();
      }
    });
    this.issueLog = new RuntimeIssueLog(
      () => persistenceFailures(this.settings.failure(), this.threads.persistenceFailures()),
      () => this.emitter.emit('issues'),
    );
    this.settings = new LocalPreferencesStore(native, (kind) =>
      kind === 'value' ? this.emitter.emit('preferences') : this.issueLog.invalidate(),
    );
    this.workspaceAdmin = new LocalWorkspaceAdmin(this, this.settings);
    this.skills = new LocalSkills(native, this.settings, () => this.emitter.emit('skills'), this);
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
    this.drafts = new LegacyDraftReader(native);
    this.models = new LocalModelSession(native, loadNativeModelContext, () =>
      this.emitter.coalesce('models'),
    );
    this.downloads = new ModelDownloadController(LOCAL_MODEL_CATALOG, native, () =>
      this.emitter.coalesce('downloads'),
    );
    this.gitAccount = new LocalGitAccount(native, this.settings, {
      requireNetwork: (action) => this.requireNetwork(action),
      gitBusy: () => this.workspaceOperation !== null || native.getGitTransferProgress().active,
    });
    this.authentication = this.gitAccount.authentication;
    this.loop = new LocalAgentLoop(
      this.threads,
      this.models,
      localTools.LOCAL_TOOL_DEFINITIONS,
      localTools.localToolExecutor(
        native,
        () => this.settings.get().author,
        (id) => this.credential(id),
        (action) => this.requireNetwork(action),
      ),
      () => {
        this.emitter.emit('loop');
        this.runActivity.changed();
      },
      localTools.localToolApproval,
      undefined,
      new localTools.LocalWorkspaceGuidance(native, this.skills),
    );
    this.residency = new ModelResidency({
      models: this.models,
      downloads: this.downloads,
      idle: () => this.loop.snapshot().phase === 'idle',
      memory: () => native.getMemoryInfo(),
    });
    this.modelSelection = new LocalModelSelection(this, this.settings, this.residency, () =>
      this.emitter.emit('models', 'downloads'),
    );
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
    return this.gitAccount.configured();
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

  sendMessage(
    id: string,
    text: string,
    submissionId: string,
    accepted: () => void,
  ): Promise<LocalThread> {
    return this.runActivity.run(
      () => this.admitTurn(id, 'sending'),
      () => this.loop.send(id, text, submissionId, accepted),
    );
  }

  retryTurn(id: string): Promise<LocalThread> {
    return this.runActivity.run(
      () => this.admitTurn(id, 'retrying'),
      () => this.loop.retry(id),
    );
  }

  /** iOS revoked the background time, or the user cancelled the run from the system UI. */
  private expireRun(): void {
    this.native.cancelGitTransfer();
    // The turn's own failure reaches its sender; only the lifecycle's failures are reported here.
    void this.loop.stop(LOCAL_RUN_EXPIRED_MESSAGE).catch(() => undefined);
    if (this.backgrounded) {
      void this.suspendFor('background').catch((error: unknown) => this.report(error));
    }
  }

  private async admitTurn(id: string, action: string): Promise<void> {
    await this.residency.settled();
    this.requireModelSelectionSettled();
    await this.requireModelPresent(this.threads.find(id)?.modelId);
    if (this.workspaceOperation || this.suspension || this.disposal) {
      throw new Error(`Wait for on-device operations to settle before ${action}.`);
    }
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

  /** Applies a confirmed rename (a workspace) or delete (null) before the list is re-read. */
  replaceWorkspace(id: string, next: LocalWorkspace | null): void {
    this.workspaceValues = next
      ? this.workspaceValues.map((entry) => (entry.id === id ? next : entry))
      : this.workspaceValues.filter((entry) => entry.id !== id);
    this.emitter.emit('workspaces');
  }

  async cloneWorkspace(name: string, url: string): Promise<LocalWorkspace> {
    this.requireNetwork('clone repositories');
    const reference = this.gitAccount.cloneCredential(url);
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
  selectModel(id: string, threadId?: string): Promise<void> {
    return this.requireModelPresent(id) ?? this.modelSelection.select(id, threadId);
  }

  /**
   * Uses a downloaded model for a conversation (when given) and for new conversations without
   * loading it; it loads when that conversation next sends. Rejects while the conversation runs.
   */
  chooseModel(id: string, threadId?: string): Promise<void> {
    return this.requireModelPresent(id) ?? this.modelSelection.choose(id, threadId);
  }

  /** Rejects while `id`'s weights are being deleted, so nothing loads a file being removed. */
  isRemovingModel(id: string | null | undefined): boolean {
    return this.modelSelection.isRemoving(id);
  }

  private requireModelPresent(id: string | null | undefined): Promise<never> | null {
    return this.isRemovingModel(id)
      ? Promise.reject(new Error('This model is being deleted. Choose another model.'))
      : null;
  }

  requireModelSelectionSettled(): void {
    this.modelSelection.requireSettled();
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
  removeModel(id: string): Promise<void> {
    return this.modelSelection.remove(id);
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

  /**
   * Unsent drafts written by builds before the shared chat shell, by conversation (= chat) id. The
   * shell imports them into the composer's draft store once, then settles them here.
   */
  legacyDrafts(): ReadonlyMap<string, string> {
    return this.drafts.pending();
  }

  /**
   * Drops legacy drafts the composer now holds and sets aside, bytes preserved, those whose chat
   * already had a newer composer draft. Call only after the composer's write succeeded.
   */
  async settleLegacyDrafts(outcomes: ReadonlyMap<string, LegacyDraftOutcome>): Promise<void> {
    const results = await Promise.allSettled(
      [...outcomes].map(([threadId, outcome]) => this.drafts.settle(threadId, outcome)),
    );
    const superseded = [...outcomes.values()].filter((outcome) => outcome === 'superseded');
    if (superseded.length > 0) {
      this.issueLog.recover(supersededDraftNotice(superseded.length));
    }
    throwFirstRejection([...results, ...(await Promise.allSettled([this.settings.flush()]))]);
  }

  saveAuthor(author: LocalGitIdentity): Promise<void> {
    return this.gitAccount.saveAuthor(author);
  }
  signIn(presentCode: (value: GitDeviceAuthorization) => Promise<void>): Promise<void> {
    return this.gitAccount.signIn(presentCode);
  }
  /** Removes the credential; rejects only while a Git transfer might be using it. */
  signOut(): Promise<void> {
    return this.gitAccount.signOut();
  }
  credential(workspaceId: string): Promise<string | null> {
    return this.gitAccount.credential(workspaceId);
  }

  /**
   * The app moved to the background. A turn holding background time keeps running with inference
   * on the CPU; otherwise local work stops, the model unloads, and state is flushed. Model
   * downloads keep running in their background URL session either way.
   */
  background(): Promise<void> {
    this.backgrounded = true;
    this.models.setPlacement('background');
    if (this.runActivity.held()) {
      return this.flush();
    }
    return this.suspendFor('background');
  }

  /** Low memory: stops local work and unloads the model without pausing downloads. */
  relieveMemory(): Promise<void> {
    return this.suspendFor('memory');
  }

  /**
   * The app is active (after startup or a return from the background): re-attaches downloads and,
   * once online, continues transfers or verification the system interrupted, then warms
   * the previously loaded model if memory admits it. A turn that kept running moves back to the
   * GPU at its next completion. Interrupted turns are never replayed.
   */
  async foreground(): Promise<void> {
    this.backgrounded = false;
    this.models.setPlacement('foreground');
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
      this.runActivity.dispose();
      this.networkMonitor.close();
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

  /** Writes settings and conversation progress that have not been saved yet. */
  async flush(): Promise<void> {
    await this.modelSelection.settled();
    await this.persist(this.threads.flush());
  }

  private async persist(threads: Promise<void>): Promise<void> {
    throwFirstRejection(await Promise.allSettled([threads, this.settings.flush()]));
  }
}
