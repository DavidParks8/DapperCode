import type { OnDeviceNativeServices } from '../native/services.types';
import type { LocalWorkspace } from '../workspaces/types';
import type { LocalPreferencesStore } from './preferences';

export interface WorkspaceAdminHost {
  readonly native: Pick<OnDeviceNativeServices, 'renameWorkspace' | 'deleteWorkspace'>;
  workspaceTask<T>(label: string, action: () => Promise<T>): Promise<T>;
  refreshWorkspaces(): Promise<void>;
}

/** Workspace rename/delete, serialized with every other manual workspace operation. */
export class LocalWorkspaceAdmin {
  constructor(
    private readonly host: WorkspaceAdminHost,
    private readonly settings: Pick<LocalPreferencesStore, 'get' | 'update' | 'save'>,
  ) {}

  rename(id: string, name: string): Promise<LocalWorkspace> {
    return this.host.workspaceTask('Renaming workspace', () =>
      this.host.native.renameWorkspace(id, name).finally(() => this.host.refreshWorkspaces()),
    );
  }

  /** Deletes a workspace's files. Its conversations stay readable; a matching selection is cleared. */
  delete(id: string): Promise<void> {
    return this.host.workspaceTask('Deleting workspace', async () => {
      await this.host.native.deleteWorkspace(id).finally(() => this.host.refreshWorkspaces());
      if (this.settings.get().workspaceId === id) {
        this.settings.update({ workspaceId: null });
        await this.settings.save();
      }
    });
  }
}
