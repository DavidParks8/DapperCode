import type { OnDeviceNativeServices } from '../native/services.types';
import type { LocalWorkspace } from '../workspaces/types';
import type { LocalPreferencesStore } from './preferences';

export interface WorkspaceAdminHost {
  readonly native: Pick<OnDeviceNativeServices, 'renameWorkspace' | 'deleteWorkspace'>;
  workspaceTask<T>(label: string, action: () => Promise<T>): Promise<T>;
  refreshWorkspaces(): Promise<void>;
  replaceWorkspace(id: string, next: LocalWorkspace | null): void;
  report(error: unknown): void;
}

/**
 * Workspace rename/delete, serialized with every other manual workspace operation.
 *
 * Only the native operation decides whether a rename or delete happened. Once it has, the change
 * is applied to the runtime's workspace list at once, so nothing can still resolve the old path or
 * the deleted workspace; re-reading the list or saving preferences afterwards are reported as
 * issues if they fail, never as a failed rename or delete.
 */
export class LocalWorkspaceAdmin {
  constructor(
    private readonly host: WorkspaceAdminHost,
    private readonly settings: Pick<LocalPreferencesStore, 'get' | 'update' | 'save'>,
  ) {}

  rename(id: string, name: string): Promise<LocalWorkspace> {
    return this.host.workspaceTask('Renaming workspace', async () => {
      const renamed = await this.attempt(() => this.host.native.renameWorkspace(id, name));
      this.host.replaceWorkspace(id, renamed);
      await this.refresh();
      return renamed;
    });
  }

  /** Deletes a workspace's files. Its conversations stay readable; a matching selection is cleared. */
  delete(id: string): Promise<void> {
    return this.host.workspaceTask('Deleting workspace', async () => {
      await this.attempt(() => this.host.native.deleteWorkspace(id));
      this.host.replaceWorkspace(id, null);
      if (this.settings.get().workspaceId === id) {
        this.settings.update({ workspaceId: null });
        // A failed save already surfaces as the retryable preferences issue.
        await this.settings.save().catch(() => undefined);
      }
      await this.refresh();
    });
  }

  /** Runs the native operation; if it fails, the list is re-read in case it partly happened. */
  private async attempt<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      await this.host.refreshWorkspaces().catch(() => undefined);
      throw error;
    }
  }

  private refresh(): Promise<void> {
    return this.host.refreshWorkspaces().catch((error: unknown) => this.host.report(error));
  }
}
