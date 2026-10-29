import { GitHubAuthStrategy } from '../auth/github';
import type { GitDeviceAuthorization } from '../auth/strategy';
import { executeGitTool, GIT_TOOL_DEFINITIONS, isGitTool } from '../git/gitTools';
import type { LocalGitIdentity } from '../git/gitTools';
import { LOCAL_MODEL_CATALOG, localModelDefinition } from '../models/catalog';
import { ModelDownloadController } from '../models/downloads';
import { loadNativeModelContext } from '../models/engine';
import { expoModelTransfers, modelResumeStorage } from '../models/expoDownloads';
import { LocalModelSession } from '../models/session';
import type { OnDeviceNativeServices } from '../native/services.types';
import { FILE_TOOL_DEFINITIONS } from '../workspaces/fileToolDefinitions';
import { executeFileTool, isFileTool } from '../workspaces/fileTools';
import type { LocalWorkspace } from '../workspaces/types';
import { LocalAgentLoop } from './agentLoop';
import { emptyLocalPreferences, parseLocalPreferences } from './preferences';
import type { LocalPreferences } from './preferences';
import { LocalThreadRepository } from './threads';
import type { LocalThread } from './types';

export class OnDeviceRuntime {
  readonly threads: LocalThreadRepository;
  readonly models: LocalModelSession;
  readonly downloads: ModelDownloadController;
  readonly loop: LocalAgentLoop;
  readonly authentication: GitHubAuthStrategy;
  private readonly githubClientId =
    process.env.EXPO_PUBLIC_GITHUB_CLIENT_ID?.trim() ?? 'Ov23ctzKpdigHwQUbG8X';
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private preferencesValue = emptyLocalPreferences();
  private workspaceValues: LocalWorkspace[] = [];
  private preferenceWrites: Promise<void> = Promise.resolve();
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: Error | null = null;
  private preferencesLoaded = false;
  private initialization: Promise<void> | null = null;
  private suspension: Promise<void> | null = null;
  private disposal: Promise<void> | null = null;
  private workspaceOperation: Promise<unknown> | null = null;
  private workspaceOperationLabel: string | null = null;

  constructor(readonly native: OnDeviceNativeServices) {
    this.threads = new LocalThreadRepository(native, () => this.emit());
    this.models = new LocalModelSession(native, loadNativeModelContext, () => this.emit());
    this.downloads = new ModelDownloadController(
      LOCAL_MODEL_CATALOG,
      native,
      expoModelTransfers,
      modelResumeStorage,
      () => this.emit(),
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
      [...FILE_TOOL_DEFINITIONS, ...GIT_TOOL_DEFINITIONS],
      (workspace, name, input) => {
        if (isFileTool(name)) {
          return executeFileTool(workspace, name, input, native);
        }
        if (isGitTool(name)) {
          return executeGitTool(
            workspace,
            name,
            input,
            native,
            () => this.preferencesValue.author,
            (id) => this.credential(id),
          );
        }
        return Promise.reject(new Error('The model requested a tool that is not available.'));
      },
      () => this.emit(),
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  version = (): number => this.revision;
  preferences(): LocalPreferences {
    return this.preferencesValue;
  }
  workspaces(): readonly LocalWorkspace[] {
    return this.workspaceValues;
  }
  error(): Error | null {
    return this.failure ?? this.threads.persistenceError();
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
        this.emit();
      });
    this.workspaceOperation = task;
    this.emit();
    return task;
  }

  sendMessage(
    id: string,
    text: string,
    submissionId: string,
    accepted: () => void,
  ): Promise<LocalThread> {
    if (this.workspaceOperation || this.suspension || this.disposal) {
      return Promise.reject(new Error('Wait for on-device operations to settle before sending.'));
    }
    return this.loop.send(id, text, submissionId, accepted);
  }

  initialize(): Promise<void> {
    this.initialization ??= this.restore().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  private async restore(): Promise<void> {
    this.preferencesValue = parseLocalPreferences(
      await this.native.readRuntimeDocument('preferences.json'),
    );
    this.preferencesLoaded = true;
    await this.threads.initialize();
    await this.refreshWorkspaces();
    await Promise.allSettled(LOCAL_MODEL_CATALOG.map((model) => this.downloads.inspect(model.id)));
    this.emit();
  }

  async createWorkspace(name: string): Promise<LocalWorkspace> {
    const workspace = await this.native.createWorkspace(name);
    await this.refreshWorkspaces();
    await this.selectWorkspace(workspace.id);
    return workspace;
  }

  async refreshWorkspaces(): Promise<void> {
    this.workspaceValues = await this.native.listWorkspaces();
    this.emit();
  }

  async cloneWorkspace(name: string, url: string): Promise<LocalWorkspace> {
    const account = this.preferencesValue.account;
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

  async selectWorkspace(id: string, threadId?: string): Promise<void> {
    if (!this.workspaceValues.some((entry) => entry.id === id)) {
      throw new Error('Choose an available local workspace.');
    }
    if (threadId && this.threads.get(threadId).messages.length > 0) {
      throw new Error('Start a new conversation to change its workspace.');
    }
    await this.stop();
    this.preferencesValue = { ...this.preferencesValue, workspaceId: id };
    if (threadId) {
      this.threads.change(threadId, (thread) => ({ ...thread, workspaceId: id }));
      await this.threads.save(threadId);
    }
    await this.savePreferences();
  }

  async selectModel(id: string, threadId?: string): Promise<void> {
    localModelDefinition(id);
    await this.stop();
    const loaded = this.models.snapshot();
    if (loaded.modelId !== id || loaded.phase !== 'ready') {
      await this.models.load(id);
    }
    this.preferencesValue = { ...this.preferencesValue, modelId: id };
    if (threadId) {
      this.threads.change(threadId, (thread) => ({ ...thread, modelId: id }));
      await this.threads.save(threadId);
    }
    await this.savePreferences();
  }

  async removeModel(id: string): Promise<void> {
    await this.stop();
    if (this.models.snapshot().modelId === id) {
      await this.models.unload();
    }
    await this.downloads.remove(id);
    if (this.preferencesValue.modelId === id) {
      this.preferencesValue = { ...this.preferencesValue, modelId: null };
      await this.savePreferences();
    }
  }

  async createThread(): Promise<LocalThread> {
    const { modelId, workspaceId } = this.preferencesValue;
    if (!modelId || !workspaceId) {
      throw new Error('Choose a downloaded model and a local workspace first.');
    }
    return this.threads.create(workspaceId, modelId);
  }

  draft(id: string): string {
    return this.preferencesValue.drafts[id] ?? '';
  }

  setDraft(id: string, text: string): void {
    this.preferencesValue = {
      ...this.preferencesValue,
      drafts: { ...this.preferencesValue.drafts, [id]: text },
    };
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
    }
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      void this.savePreferences().catch((error: unknown) => this.report(error));
    }, 200);
  }

  async saveAuthor(author: LocalGitIdentity): Promise<void> {
    if (!author.name.trim() || !author.email.trim()) {
      throw new Error('Enter a Git author name and email.');
    }
    this.preferencesValue = {
      ...this.preferencesValue,
      author: { name: author.name.trim(), email: author.email.trim() },
    };
    await this.savePreferences();
  }

  async signIn(presentCode: (value: GitDeviceAuthorization) => Promise<void>): Promise<void> {
    const account = await this.authentication.signIn(presentCode);
    this.preferencesValue = {
      ...this.preferencesValue,
      account,
      author: this.preferencesValue.author ?? {
        name: account.login,
        email: `${account.id}+${account.login}@users.noreply.github.com`,
      },
    };
    await this.savePreferences();
  }

  async signOut(): Promise<void> {
    await this.stop();
    const account = this.preferencesValue.account;
    if (account) {
      await this.authentication.signOut(account);
    }
    this.preferencesValue = { ...this.preferencesValue, account: null };
    await this.savePreferences();
  }

  async credential(workspaceId: string): Promise<string | null> {
    const account = this.preferencesValue.account;
    if (!account) {
      return null;
    }
    return this.authentication.resolveCredential(
      account,
      await this.native.getWorkspaceGitOrigin(workspaceId),
    );
  }

  async background(): Promise<void> {
    this.suspension ??= this.suspend(false).finally(() => {
      this.suspension = null;
    });
    return this.suspension;
  }

  dispose(): Promise<void> {
    this.authentication.cancelSignIn();
    this.disposal ??= this.finishDisposal();
    return this.disposal;
  }

  private async finishDisposal(): Promise<void> {
    const previous = this.suspension ? await Promise.allSettled([this.suspension]) : [];
    try {
      await this.suspend(true);
      const failed = previous.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        throw failed.reason;
      }
    } finally {
      this.listeners.clear();
    }
  }

  private async suspend(dispose: boolean): Promise<void> {
    this.native.cancelGitTransfer();
    const stopping = await Promise.allSettled([this.loop.stop()]);
    const workspace = this.workspaceOperation
      ? await Promise.allSettled([this.workspaceOperation])
      : [];
    const results = await Promise.allSettled([
      dispose ? this.models.dispose() : this.models.unload(),
      this.downloads.pause(),
      this.flush(),
    ]);
    const failed = [...stopping, ...workspace, ...results].find(
      (result) => result.status === 'rejected',
    );
    if (failed?.status === 'rejected') {
      throw failed.reason;
    }
  }

  async flush(): Promise<void> {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    await this.savePreferences();
    await this.threads.flush();
  }

  report(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error('The on-device operation failed.');
    this.emit();
  }

  dismissError(): void {
    this.failure = null;
    this.emit();
  }

  private savePreferences(): Promise<void> {
    if (!this.preferencesLoaded) {
      return Promise.reject(
        new Error('Local preferences have not loaded. Stored data has been preserved.'),
      );
    }
    const contents = JSON.stringify(this.preferencesValue);
    const write = this.preferenceWrites.then(() =>
      this.native.writeRuntimeDocument('preferences.json', contents),
    );
    this.preferenceWrites = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(
      () => {
        this.emit();
      },
      (error: unknown) => {
        this.report(error);
        throw error;
      },
    );
  }

  private emit(): void {
    this.revision += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
