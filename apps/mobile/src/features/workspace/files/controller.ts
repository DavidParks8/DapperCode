import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { WorkspaceHostClient } from '../api/client';
import { describeHostError, hostErrorNativeCode } from '../api/errors';
import type { WorkspaceFileEntry, WorkspaceFileListResponse } from '../api/protocol';

/** How often the screen asks whether the agent or Git changed the workspace. */
export const FILES_CHANGE_POLL_MS = 2_000;

export interface OpenWorkspaceFile {
  path: string;
  /** Content as last read or saved. */
  original: string;
  draft: string;
  revision: string;
  /** Only the beginning of a large file was read; it opens read-only. */
  truncated: boolean;
  totalBytes: number;
}

export function joinFilePath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

export function parentFilePath(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

export function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** User-facing problem with a new name, or null when it can be used. */
export function fileNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Enter a name.';
  }
  if (trimmed.includes('/')) {
    return 'Names cannot contain “/”.';
  }
  if (trimmed === '.' || trimmed === '..') {
    return 'Choose a different name.';
  }
  return null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface UseWorkspaceFilesArgs {
  host: WorkspaceHostClient | null;
  cwd: string | null;
  /** Polling only runs while the screen is focused. */
  focused: boolean;
}

/**
 * State for the Files screen: the current folder, the open file and its unsaved draft, and
 * refreshes driven by the host's change token. Edits are never dropped implicitly: closing a
 * dirty file is refused until the user saves or discards, and outside changes to a dirty file are
 * reported instead of reloaded.
 */
export function useWorkspaceFiles({ host, cwd, focused }: UseWorkspaceFilesArgs) {
  const [directory, setDirectory] = useState('');
  const [listing, setListing] = useState<WorkspaceFileListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<OpenWorkspaceFile | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const [unsavedBlocked, setUnsavedBlocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const directoryRef = useRef(directory);
  directoryRef.current = directory;
  const fileRef = useRef(file);
  fileRef.current = file;
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const dirty = file !== null && !file.truncated && file.draft !== file.original;

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!host || !cwd) {
        return;
      }
      setLoading(true);
      try {
        const next = await host.listFiles(cwd, path);
        if (mountedRef.current && directoryRef.current === path) {
          setListing(next);
          setError(null);
        }
      } catch (reason) {
        if (mountedRef.current && directoryRef.current === path) {
          setError(describeHostError(reason, 'Could not list this folder.'));
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    },
    [cwd, host],
  );

  const readToken = useCallback(async () => {
    if (!host || !cwd) {
      return null;
    }
    try {
      return (await host.changeToken(cwd)).token;
    } catch {
      return null;
    }
  }, [cwd, host]);

  useEffect(() => {
    directoryRef.current = directory;
    void loadDirectory(directory);
  }, [directory, loadDirectory]);

  const readFile = useCallback(
    async (path: string): Promise<OpenWorkspaceFile | null> => {
      if (!host || !cwd) {
        return null;
      }
      const read = await host.readFile(cwd, path);
      return {
        path,
        original: read.content,
        draft: read.content,
        revision: read.revision,
        truncated: read.truncated,
        totalBytes: read.totalBytes,
      };
    },
    [cwd, host],
  );

  const reloadFromDisk = useCallback(async () => {
    const current = fileRef.current;
    if (!current) {
      return;
    }
    try {
      const next = await readFile(current.path);
      if (mountedRef.current && next) {
        setFile(next);
        setConflict(false);
        setChangedOnDisk(false);
        setUnsavedBlocked(false);
        setError(null);
      }
    } catch (reason) {
      if (mountedRef.current) {
        setError(describeHostError(reason, 'Could not reload the file.'));
      }
    }
  }, [readFile]);

  const refresh = useCallback(async () => {
    tokenRef.current = await readToken();
    await loadDirectory(directoryRef.current);
    const current = fileRef.current;
    if (current && current.draft === current.original) {
      await reloadFromDisk();
    }
  }, [loadDirectory, readToken, reloadFromDisk]);

  useEffect(() => {
    if (!focused || !host || !cwd) {
      return;
    }
    let cancelled = false;
    void readToken().then((token) => {
      if (!cancelled && tokenRef.current === null) {
        tokenRef.current = token;
      }
    });
    const timer = setInterval(() => {
      if (AppState.currentState === 'background' || AppState.currentState === 'inactive') {
        return;
      }
      void readToken().then((token) => {
        if (cancelled || token === null || token === tokenRef.current) {
          return;
        }
        const first = tokenRef.current === null;
        tokenRef.current = token;
        if (first) {
          return;
        }
        void loadDirectory(directoryRef.current);
        const current = fileRef.current;
        if (!current) {
          return;
        }
        if (current.draft === current.original) {
          void reloadFromDisk();
        } else {
          setChangedOnDisk(true);
        }
      });
    }, FILES_CHANGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cwd, focused, host, loadDirectory, readToken, reloadFromDisk]);

  const openDirectory = useCallback((path: string) => {
    if (fileRef.current) {
      return;
    }
    setNotice(null);
    setError(null);
    setListing(null);
    setDirectory(path);
  }, []);

  const openFile = useCallback(
    async (entry: WorkspaceFileEntry) => {
      setOpening(entry.path);
      setNotice(null);
      try {
        const next = await readFile(entry.path);
        if (mountedRef.current && next) {
          setFile(next);
          setConflict(false);
          setChangedOnDisk(false);
          setUnsavedBlocked(false);
          setError(null);
        }
      } catch (reason) {
        if (mountedRef.current) {
          setError(describeHostError(reason, `Could not open ${entry.name}.`));
        }
      } finally {
        if (mountedRef.current) {
          setOpening(null);
        }
      }
    },
    [readFile],
  );

  const setDraft = useCallback((draft: string) => {
    setFile((current) => (current && !current.truncated ? { ...current, draft } : current));
    setUnsavedBlocked(false);
  }, []);

  /** Closes the editor; refused (and explained) while there are unsaved edits. */
  const closeFile = useCallback((): boolean => {
    const current = fileRef.current;
    if (current && !current.truncated && current.draft !== current.original) {
      setUnsavedBlocked(true);
      return false;
    }
    setFile(null);
    setConflict(false);
    setChangedOnDisk(false);
    setUnsavedBlocked(false);
    setError(null);
    return true;
  }, []);

  const write = useCallback(
    async (revision: string) => {
      const current = fileRef.current;
      if (!host || !cwd || !current) {
        return false;
      }
      setSaving(true);
      try {
        const saved = await host.writeFile(cwd, current.path, current.draft, revision);
        tokenRef.current = await readToken();
        if (mountedRef.current) {
          setFile((latest) =>
            latest && latest.path === current.path
              ? {
                  ...latest,
                  original: current.draft,
                  revision: saved.revision,
                  totalBytes: current.draft.length,
                }
              : latest,
          );
          setConflict(false);
          setChangedOnDisk(false);
          setUnsavedBlocked(false);
          setError(null);
          setNotice(`Saved ${fileName(current.path)}.`);
        }
        void loadDirectory(directoryRef.current);
        return true;
      } catch (reason) {
        if (mountedRef.current) {
          if (hostErrorNativeCode(reason) === 'FILE_REVISION_CONFLICT') {
            setConflict(true);
          }
          setError(describeHostError(reason, 'Could not save the file.'));
        }
        return false;
      } finally {
        if (mountedRef.current) {
          setSaving(false);
        }
      }
    },
    [cwd, host, loadDirectory, readToken],
  );

  const save = useCallback(async () => {
    const current = fileRef.current;
    return current ? write(current.revision) : false;
  }, [write]);

  /** Replaces whatever is on disk now with the draft, after a revision conflict. */
  const overwrite = useCallback(async () => {
    const current = fileRef.current;
    if (!host || !cwd || !current) {
      return false;
    }
    try {
      const latest = await host.readFile(cwd, current.path);
      return await write(latest.revision);
    } catch (reason) {
      setError(describeHostError(reason, 'Could not save the file.'));
      return false;
    }
  }, [cwd, host, write]);

  /** Drops unsaved edits and shows the file as it is on disk. */
  const discardEdits = useCallback(async () => {
    setFile((current) => (current ? { ...current, draft: current.original } : current));
    setUnsavedBlocked(false);
    if (changedOnDisk || conflict) {
      await reloadFromDisk();
    }
  }, [changedOnDisk, conflict, reloadFromDisk]);

  const mutate = useCallback(
    async (
      action: (client: WorkspaceHostClient, workspace: string) => Promise<unknown>,
      fallback: string,
      success: string,
    ): Promise<boolean> => {
      if (!host || !cwd) {
        return false;
      }
      try {
        await action(host, cwd);
        tokenRef.current = await readToken();
        if (mountedRef.current) {
          setError(null);
          setNotice(success);
        }
        await loadDirectory(directoryRef.current);
        return true;
      } catch (reason) {
        if (mountedRef.current) {
          setError(describeHostError(reason, fallback));
        }
        return false;
      }
    },
    [cwd, host, loadDirectory, readToken],
  );

  const createFile = useCallback(
    async (name: string) => {
      const path = joinFilePath(directoryRef.current, name.trim());
      const created = await mutate(
        (client, workspace) => client.createFile(workspace, path),
        'Could not create the file.',
        `Created ${name.trim()}.`,
      );
      if (created) {
        await openFile({ name: name.trim(), path, kind: 'file', bytes: 0 });
      }
      return created;
    },
    [mutate, openFile],
  );

  const renameEntry = useCallback(
    (entry: WorkspaceFileEntry, name: string) =>
      mutate(
        (client, workspace) =>
          client.renameFile(
            workspace,
            entry.path,
            joinFilePath(parentFilePath(entry.path), name.trim()),
          ),
        `Could not rename ${entry.name}.`,
        `Renamed ${entry.name} to ${name.trim()}.`,
      ),
    [mutate],
  );

  const removeEntry = useCallback(
    (entry: WorkspaceFileEntry) =>
      mutate(
        (client, workspace) => client.removeFile(workspace, entry.path),
        `Could not delete ${entry.name}.`,
        `Deleted ${entry.name}.`,
      ),
    [mutate],
  );

  return {
    directory,
    listing,
    loading,
    error,
    notice,
    file,
    opening,
    saving,
    dirty,
    conflict,
    changedOnDisk,
    unsavedBlocked,
    setUnsavedBlocked,
    openDirectory,
    openFile,
    closeFile,
    setDraft,
    save,
    overwrite,
    discardEdits,
    reloadFromDisk,
    refresh,
    createFile,
    renameEntry,
    removeEntry,
  };
}

export type WorkspaceFilesController = ReturnType<typeof useWorkspaceFiles>;
