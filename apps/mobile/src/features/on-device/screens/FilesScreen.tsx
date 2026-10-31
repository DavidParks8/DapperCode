import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import {
  joinWorkspacePath,
  LOCAL_WORKSPACE_ROOT,
  parentWorkspacePath,
  type LocalDirectoryListing,
  type LocalFileRead,
} from '../workspaces/types';
import { LocalAction, LocalCard, LocalField, LocalPage, LocalText, useLocalOperation } from './ui';

const LISTING_LIMIT = 200;
const MISSING_WORKSPACE = 'Choose a local workspace first.';

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  const kib = bytes / 1024;
  return kib < 1024 ? `${kib.toFixed(1)} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
}

export function LocalFilesScreen() {
  const runtime = useOnDeviceRuntime();
  const { workspaceId = '' } = useLocalSearchParams<{ workspaceId: string }>();
  const [directory, setDirectory] = useState(LOCAL_WORKSPACE_ROOT);
  const [listing, setListing] = useState<LocalDirectoryListing | null>(null);
  const [file, setFile] = useState<(LocalFileRead & { name: string }) | null>(null);
  const [content, setContent] = useState('');
  const [newPath, setNewPath] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const changeToken = useRef<string | null>(null);
  const operation = useLocalOperation();
  const refresh = useCallback(() => setRefreshes((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setListing(null);
    setReadError(null);
    if (!workspaceId) {
      setReadError(MISSING_WORKSPACE);
      return;
    }
    void runtime.native
      .listWorkspaceFiles(workspaceId, directory, LISTING_LIMIT)
      .then((result) => {
        if (active) {
          setListing(result);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setReadError(error instanceof Error ? error.message : 'Could not list local files.');
        }
      });
    return () => {
      active = false;
    };
  }, [directory, runtime, workspaceId, refreshes]);
  const version = runtime.version();
  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    let active = true;
    // Agent tool edits change the native token; refresh the listing when it moves.
    void runtime.native.getWorkspaceChangeToken(workspaceId).then(
      (token) => {
        if (active && changeToken.current !== token) {
          if (changeToken.current !== null) {
            refresh();
          }
          changeToken.current = token;
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [refresh, runtime, version, workspaceId]);
  const open = (path: string) =>
    operation.run(async () => {
      const read = await runtime.native.readWorkspaceFile(workspaceId, path, 0, 65536);
      setFile({ ...read, name: path });
      setContent(read.content);
    });
  const mutate = (label: string, action: () => Promise<void>) =>
    operation.run(() =>
      runtime.workspaceTask(label, async () => {
        await action();
        changeToken.current = await runtime.native.getWorkspaceChangeToken(workspaceId);
        refresh();
      }),
    );
  return (
    <LocalPage title="Local files" busy={operation.busy} error={operation.error ?? readError}>
      <LocalText title>{directory || 'Workspace root'}</LocalText>
      {directory !== LOCAL_WORKSPACE_ROOT ? (
        <LocalAction
          title="Parent folder"
          onPress={() => setDirectory(parentWorkspacePath(directory))}
        />
      ) : null}
      <LocalAction
        title="Refresh files"
        disabled={operation.busy || !workspaceId}
        onPress={refresh}
      />
      {listing?.entries.map((entry) => {
        const path = joinWorkspacePath(directory, entry.name);
        return (
          <LocalAction
            key={entry.name}
            title={`${entry.kind === 'directory' ? 'Folder: ' : ''}${entry.name}`}
            disabled={operation.busy || (entry.kind !== 'file' && entry.kind !== 'directory')}
            onPress={() => (entry.kind === 'directory' ? setDirectory(path) : open(path))}
          />
        );
      })}
      {listing?.truncated ? (
        <LocalText>Showing the first {LISTING_LIMIT} entries in this folder.</LocalText>
      ) : null}
      {file ? (
        <LocalCard>
          <LocalText title>{file.name}</LocalText>
          <LocalField
            label="File content"
            multiline
            value={content}
            onChangeText={setContent}
            editable={file.nextOffset === null && !operation.busy}
            style={{ minHeight: 200, textAlignVertical: 'top' }}
          />
          {file.nextOffset !== null ? (
            <LocalText>
              Read-only preview of the first {formatBytes(file.nextOffset)} of{' '}
              {formatBytes(file.totalBytes)}. Files over 64 KiB cannot be edited here.
            </LocalText>
          ) : (
            <LocalAction
              title="Save file"
              disabled={operation.busy}
              onPress={() =>
                operation.run(() =>
                  runtime.workspaceTask('Saving file', async () => {
                    const revision = await runtime.native.writeWorkspaceFile(
                      workspaceId,
                      file.name,
                      content,
                      file.revision,
                    );
                    setFile({ ...file, content, revision });
                  }),
                )
              }
            />
          )}
          <FileManageActions
            key={file.name}
            path={file.name}
            busy={operation.busy}
            onRename={(destination) =>
              mutate('Renaming file', async () => {
                await runtime.native.renameWorkspaceEntry(workspaceId, file.name, destination);
                setFile(null);
              })
            }
            onDelete={() =>
              mutate('Deleting file', async () => {
                await runtime.native.removeWorkspaceEntry(workspaceId, file.name);
                setFile(null);
              })
            }
          />
        </LocalCard>
      ) : null}
      <LocalCard>
        <LocalField
          label="New file name"
          value={newPath}
          onChangeText={setNewPath}
          placeholder="notes.txt"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <LocalAction
          title="Create empty file"
          disabled={operation.busy || !newPath.trim() || !workspaceId}
          onPress={() =>
            mutate('Creating file', async () => {
              await runtime.native.writeWorkspaceFile(
                workspaceId,
                joinWorkspacePath(directory, newPath.trim()),
                '',
                null,
              );
              setNewPath('');
            })
          }
        />
      </LocalCard>
    </LocalPage>
  );
}

function FileManageActions({
  path,
  busy,
  onRename,
  onDelete,
}: {
  path: string;
  busy: boolean;
  onRename: (destination: string) => void;
  onDelete: () => void;
}) {
  const [destination, setDestination] = useState(path);
  const target = destination.trim();
  return (
    <>
      <LocalField
        label="File path"
        value={destination}
        onChangeText={setDestination}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <LocalAction
        title="Rename file"
        disabled={busy || !target || target === path}
        onPress={() => onRename(target)}
      />
      <LocalAction title="Delete file" destructive disabled={busy} onPress={onDelete} />
    </>
  );
}
