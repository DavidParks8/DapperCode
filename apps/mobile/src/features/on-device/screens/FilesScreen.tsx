import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import type { LocalDirectoryListing, LocalFileRead } from '../workspaces/types';
import { LocalAction, LocalCard, LocalField, LocalPage, LocalText, useLocalOperation } from './ui';

export function LocalFilesScreen() {
  const runtime = useOnDeviceRuntime();
  const { workspaceId = '' } = useLocalSearchParams<{ workspaceId: string }>();
  const [directory, setDirectory] = useState('.');
  const [listing, setListing] = useState<LocalDirectoryListing | null>(null);
  const [file, setFile] = useState<(LocalFileRead & { name: string }) | null>(null);
  const [content, setContent] = useState('');
  const [newPath, setNewPath] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const operation = useLocalOperation();
  useEffect(() => {
    let active = true;
    setListing(null);
    setReadError(null);
    void runtime.native
      .listWorkspaceFiles(workspaceId, directory, 200)
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
  }, [directory, runtime, workspaceId]);
  const open = (path: string) =>
    operation.run(async () => {
      const read = await runtime.native.readWorkspaceFile(workspaceId, path, 0, 65536);
      setFile({ ...read, name: path });
      setContent(read.content);
    });
  return (
    <LocalPage title="Local files" busy={operation.busy} error={operation.error ?? readError}>
      <LocalText title>{directory}</LocalText>
      {directory !== '.' ? (
        <LocalAction
          title="Parent folder"
          onPress={() => setDirectory(directory.split('/').slice(0, -1).join('/') || '.')}
        />
      ) : null}
      {listing?.entries.map((entry) => {
        const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
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
        <LocalText>
          Listing truncated to 200 entries. The agent can search within this workspace.
        </LocalText>
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
              Read-only preview: this file exceeds the 64 KiB editor limit. Agent tools support
              bounded reads.
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
        </LocalCard>
      ) : null}
      <LocalCard>
        <LocalField
          label="New file path"
          value={newPath}
          onChangeText={setNewPath}
          placeholder="notes.txt"
        />
        <LocalAction
          title="Create empty file"
          disabled={operation.busy || !newPath.trim()}
          onPress={() =>
            operation.run(() =>
              runtime.workspaceTask('Creating file', async () => {
                await runtime.native.writeWorkspaceFile(workspaceId, newPath.trim(), '', null);
                const result = await runtime.native.listWorkspaceFiles(workspaceId, directory, 200);
                setListing(result);
                setNewPath('');
              }),
            )
          }
        />
      </LocalCard>
    </LocalPage>
  );
}
