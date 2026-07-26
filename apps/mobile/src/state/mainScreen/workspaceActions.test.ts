import type { HostBridgeApiClient } from '../../api/client';
import type { AppStore } from '../types';
import { createBridgeTestStore } from '../testing';
import { defaultStartCwdAtom } from '../appState/settings';
import { currentScreenAtom } from '../navigation/atoms';
import {
  gitCheckoutCloningAtom,
  gitCheckoutDirectoryNameAtom,
  gitCheckoutDirectoryNameEditedAtom,
  gitCheckoutErrorAtom,
  gitCheckoutParentPathAtom,
  gitCheckoutRepoUrlAtom,
  resumeGitCheckoutAfterWorkspacePickerAtom,
} from './gitCheckout';
import {
  favoriteWorkspacePathsAtom,
  loadingWorkspaceBrowseAtom,
  workspaceBridgeRootAtom,
  workspaceBrowseEntriesAtom,
  workspaceBrowseErrorAtom,
  workspaceBrowseParentPathAtom,
  workspaceBrowsePathAtom,
  workspaceBrowseTruncationAtom,
  workspacePickerPurposeAtom,
  workspacePickerReturnScreenAtom,
  workspaceRootsAtom,
} from './workspace';
import {
  browseWorkspacePathAtom,
  changeGitCheckoutDirectoryNameAtom,
  changeGitCheckoutRepoUrlAtom,
  closeGitCheckoutAtom,
  closeWorkspacePickerAtom,
  openGitCheckoutAtom,
  openGitCheckoutDestinationPickerAtom,
  openWorkspaceModalAtom,
  refreshWorkspaceRootsAtom,
  selectWorkspaceAtom,
  submitGitCheckoutAtom,
  toggleWorkspaceFavoriteAtom,
} from './workspaceActions';

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  readAsStringAsync: jest.fn().mockRejectedValue(new Error('missing')),
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn(),
}));

interface ApiMocks {
  listFilesystemEntries: jest.Mock;
  listWorkspaceRoots: jest.Mock;
  gitClone: jest.Mock;
}

function createStore(overrides: Partial<ApiMocks> = {}): { store: AppStore; api: ApiMocks } {
  const api: ApiMocks = {
    listFilesystemEntries: overrides.listFilesystemEntries ?? jest.fn(),
    listWorkspaceRoots: overrides.listWorkspaceRoots ?? jest.fn(),
    gitClone: overrides.gitClone ?? jest.fn(),
  };
  const store = createBridgeTestStore({ api: api as unknown as HostBridgeApiClient });
  return { store, api };
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    bridgeRoot: '/workspace',
    path: '/workspace',
    parentPath: null,
    truncated: false,
    totalEntries: 1,
    entries: [{ name: 'mobile', path: '/workspace/mobile', isDirectory: true, isGitRepo: false }],
    ...overrides,
  };
}

describe('workspace actions', () => {
  it('publishes roots and reports a failed refresh', async () => {
    const { store, api } = createStore();
    api.listWorkspaceRoots
      .mockResolvedValueOnce({ bridgeRoot: '/workspace', workspaces: [{ path: '/a', chatCount: 1 }] })
      .mockRejectedValueOnce(new Error('roots unavailable'));

    await store.set(refreshWorkspaceRootsAtom);
    expect(store.get(workspaceBridgeRootAtom)).toBe('/workspace');
    expect(store.get(workspaceRootsAtom)).toEqual([{ path: '/a', chatCount: 1 }]);

    expect(await store.set(refreshWorkspaceRootsAtom)).toBeNull();
    expect(store.get(workspaceBrowseErrorAtom)).toBe('roots unavailable');
  });

  it('serves the browse cache before the network and reports truncation', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValue(listing({ truncated: true, totalEntries: 9 }));

    await store.set(browseWorkspacePathAtom, '/workspace');
    expect(store.get(workspaceBrowsePathAtom)).toBe('/workspace');
    expect(store.get(workspaceBrowseParentPathAtom)).toBeNull();
    expect(store.get(workspaceBrowseEntriesAtom)).toHaveLength(1);
    expect(store.get(workspaceBrowseTruncationAtom)).toBe('Showing 1 of 9 entries.');
    expect(store.get(loadingWorkspaceBrowseAtom)).toBe(false);

    api.listFilesystemEntries.mockResolvedValue(listing({ truncated: false }));
    await store.set(browseWorkspacePathAtom, '/workspace');
    expect(store.get(workspaceBrowseTruncationAtom)).toBeNull();
  });

  it('falls back to the start folder when the saved workspace is gone', async () => {
    const { store, api } = createStore();
    store.set(defaultStartCwdAtom, '/workspace/missing');
    api.listFilesystemEntries
      .mockRejectedValueOnce(new Error('workspace directory is invalid or inaccessible'))
      .mockResolvedValueOnce(listing({ path: '/workspace' }));

    await store.set(browseWorkspacePathAtom, '/workspace/missing');
    expect(store.get(workspaceBrowseErrorAtom)).toBe(
      'Saved workspace was not found. Showing start folder.'
    );
    expect(store.get(defaultStartCwdAtom)).toBeNull();
  });

  it('surfaces the original error when the fallback listing also fails', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries
      .mockRejectedValueOnce(new Error('workspace directory must point to a folder'))
      .mockRejectedValueOnce(new Error('root denied'));

    await store.set(browseWorkspacePathAtom, '/workspace/missing');
    expect(store.get(workspaceBrowseErrorAtom)).toBe(
      'workspace directory must point to a folder'
    );
  });

  it('reports an unrecoverable browse failure', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockRejectedValue(new Error('browse denied'));

    await store.set(browseWorkspacePathAtom, null);
    expect(store.get(workspaceBrowseErrorAtom)).toBe('browse denied');
  });

  it('routes the picker back to where it was opened from', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValue(listing());
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: '/workspace', workspaces: [] });
    store.set(currentScreenAtom, 'Main');

    store.set(openWorkspaceModalAtom);
    expect(store.get(currentScreenAtom)).toBe('WorkspacePicker');
    expect(store.get(workspacePickerPurposeAtom)).toBe('default-start');
    expect(store.get(workspacePickerReturnScreenAtom)).toBe('Main');

    store.set(closeWorkspacePickerAtom);
    expect(store.get(currentScreenAtom)).toBe('Main');
  });

  it('returns to git checkout after choosing a destination', async () => {
    const { store, api } = createStore();
    api.listFilesystemEntries.mockResolvedValue(listing());
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: '/workspace', workspaces: [] });

    store.set(openGitCheckoutAtom, '/workspace');
    expect(store.get(currentScreenAtom)).toBe('GitCheckout');
    expect(store.get(gitCheckoutParentPathAtom)).toBe('/workspace');

    store.set(openGitCheckoutDestinationPickerAtom);
    expect(store.get(currentScreenAtom)).toBe('WorkspacePicker');
    expect(store.get(resumeGitCheckoutAfterWorkspacePickerAtom)).toBe(true);

    // Backing out of the picker resumes the checkout it interrupted.
    store.set(closeWorkspacePickerAtom);
    expect(store.get(currentScreenAtom)).toBe('GitCheckout');
    expect(store.get(resumeGitCheckoutAfterWorkspacePickerAtom)).toBe(false);

    store.set(openGitCheckoutDestinationPickerAtom);
    store.set(selectWorkspaceAtom, '/workspace/destination');
    expect(store.get(currentScreenAtom)).toBe('GitCheckout');
    expect(store.get(gitCheckoutParentPathAtom)).toBe('/workspace/destination');
  });

  it('records the chosen default workspace and leaves the picker', () => {
    const { store } = createStore();
    store.set(workspacePickerReturnScreenAtom, 'Main');
    store.set(workspacePickerPurposeAtom, 'default-start');

    store.set(selectWorkspaceAtom, '/workspace/app');
    expect(store.get(defaultStartCwdAtom)).toBe('/workspace/app');
    expect(store.get(currentScreenAtom)).toBe('Main');
  });

  it('keeps the checkout open while a clone is running', () => {
    const { store } = createStore();
    store.set(currentScreenAtom, 'GitCheckout');
    store.set(gitCheckoutCloningAtom, true);

    store.set(closeGitCheckoutAtom);
    expect(store.get(currentScreenAtom)).toBe('GitCheckout');

    store.set(gitCheckoutCloningAtom, false);
    store.set(closeGitCheckoutAtom);
    expect(store.get(currentScreenAtom)).toBe('Main');
  });

  it('derives the directory name until the field is edited', () => {
    const { store } = createStore();

    store.set(changeGitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
    expect(store.get(gitCheckoutDirectoryNameAtom)).toBe('repo');

    store.set(changeGitCheckoutDirectoryNameAtom, 'custom');
    expect(store.get(gitCheckoutDirectoryNameEditedAtom)).toBe(true);

    store.set(changeGitCheckoutRepoUrlAtom, 'git@github.com:org/other.git');
    expect(store.get(gitCheckoutDirectoryNameAtom)).toBe('custom');

    // Clearing the field hands control back to the derived name.
    store.set(changeGitCheckoutDirectoryNameAtom, '  ');
    store.set(changeGitCheckoutRepoUrlAtom, 'git@github.com:org/third.git');
    expect(store.get(gitCheckoutDirectoryNameAtom)).toBe('third');
  });

  it('validates the clone form before calling the bridge', async () => {
    const { store, api } = createStore();
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: null, workspaces: [] });

    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('Paste an HTTPS or SSH repository URL first.');

    store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('Choose a valid folder name for the cloned repo.');

    store.set(gitCheckoutDirectoryNameAtom, 'repo');
    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('Choose where the repository should be cloned.');
    expect(api.gitClone).not.toHaveBeenCalled();
  });

  it('reports clone failures and adopts the workspace on success', async () => {
    const { store, api } = createStore();
    store.set(gitCheckoutRepoUrlAtom, ' git@github.com:org/repo.git ');
    store.set(gitCheckoutDirectoryNameAtom, 'repo');
    store.set(gitCheckoutParentPathAtom, '/workspace');
    store.set(currentScreenAtom, 'GitCheckout');
    api.gitClone
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'permission denied', cloned: false })
      .mockRejectedValueOnce(new Error('clone transport failed'))
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', cloned: true, cwd: null });

    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toContain('permission denied');
    expect(store.get(currentScreenAtom)).toBe('GitCheckout');

    await store.set(submitGitCheckoutAtom);
    expect(store.get(gitCheckoutErrorAtom)).toBe('clone transport failed');

    await store.set(submitGitCheckoutAtom);
    expect(api.gitClone).toHaveBeenLastCalledWith({
      url: 'git@github.com:org/repo.git',
      parentPath: '/workspace',
      directoryName: 'repo',
    });
    expect(store.get(defaultStartCwdAtom)).toBe('/workspace/repo');
    expect(store.get(workspaceBrowsePathAtom)).toBe('/workspace/repo');
    expect(store.get(workspaceBrowseParentPathAtom)).toBe('/workspace');
    expect(store.get(currentScreenAtom)).toBe('Main');
    expect(store.get(gitCheckoutCloningAtom)).toBe(false);
  });

  it('resolves the parent path from the bridge root when none was chosen', async () => {
    const { store, api } = createStore();
    store.set(gitCheckoutRepoUrlAtom, 'git@github.com:org/repo.git');
    store.set(gitCheckoutDirectoryNameAtom, 'repo');
    api.listWorkspaceRoots.mockResolvedValue({ bridgeRoot: '/bridge-root', workspaces: [] });
    api.gitClone.mockResolvedValue({
      code: 0,
      stdout: '',
      stderr: '',
      cloned: true,
      cwd: '/bridge-root/repo',
    });

    await store.set(submitGitCheckoutAtom);
    expect(api.gitClone).toHaveBeenCalledWith({
      url: 'git@github.com:org/repo.git',
      parentPath: '/bridge-root',
      directoryName: 'repo',
    });
    expect(store.get(defaultStartCwdAtom)).toBe('/bridge-root/repo');
  });

  it('toggles favorites and ignores blank paths', () => {
    const { store } = createStore();

    store.set(toggleWorkspaceFavoriteAtom, '   ');
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual([]);

    store.set(toggleWorkspaceFavoriteAtom, '/workspace/a');
    store.set(toggleWorkspaceFavoriteAtom, '/workspace/b');
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/workspace/b', '/workspace/a']);

    store.set(toggleWorkspaceFavoriteAtom, '/workspace/b');
    expect(store.get(favoriteWorkspacePathsAtom)).toEqual(['/workspace/a']);
  });
});
