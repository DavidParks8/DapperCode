import type { OnDeviceNativeServices } from '../native/services.types';
import {
  argumentsRecord,
  expectedRevision,
  integer,
  LocalToolInputError,
  text,
} from '../runtime/toolArguments';
import {
  FILE_TOOL_DEFINITIONS,
  type FileToolName,
  LIST_DIRECTORY_DEFAULT_LIMIT,
  LIST_DIRECTORY_MAX_LIMIT,
  READ_FILE_DEFAULT_BYTES,
  READ_FILE_MAX_BYTES,
} from './fileToolDefinitions';

export type FileToolPort = Pick<
  OnDeviceNativeServices,
  | 'listWorkspaceFiles'
  | 'readWorkspaceFile'
  | 'writeWorkspaceFile'
  | 'editWorkspaceFile'
  | 'renameWorkspacePath'
  | 'removeWorkspacePath'
  | 'searchWorkspaceFiles'
  | 'queryWorkspaceFiles'
  | 'applyWorkspacePatch'
  | 'beginWorkspaceOperation'
  | 'cancelWorkspaceOperation'
  | 'finishWorkspaceOperation'
>;

let operationSequence = 0;

/** Candidates for before-tool rule loading; native still owns full patch/path validation. */
export function workspacePatchPaths(patch: string): string[] {
  if (patch.length > 4 * 1024 * 1024) {
    throw new LocalToolInputError('Patch input exceeds 4 MiB.');
  }
  const markers = ['*** Add File: ', '*** Update File: ', '*** Delete File: ', '*** Move to: '];
  const paths: string[] = [];
  for (const [line] of patch.matchAll(/[^\n]+/gu)) {
    const marker = markers.find((prefix) => line.startsWith(prefix));
    if (marker !== undefined) {
      if (paths.length === 64) {
        throw new LocalToolInputError('A patch may touch at most 64 source/destination paths.');
      }
      paths.push(line.slice(marker.length));
    }
  }
  return [...new Set(paths)];
}

function patchRevisions(patch: string, versions: ReadonlyMap<string, string>) {
  const revisions: Record<string, string> = {};
  for (const path of workspacePatchPaths(patch)) {
    const revision = versions.get(path);
    if (revision !== undefined) {
      revisions[path] = revision;
    }
  }
  return revisions;
}

async function operation<T>(
  native: FileToolPort,
  signal: AbortSignal | undefined,
  action: (token: string) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) {
    throw new LocalToolInputError('Workspace operation cancelled.');
  }
  const token = `workspace-${Date.now()}-${++operationSequence}`;
  native.beginWorkspaceOperation(token);
  const cancel = () => native.cancelWorkspaceOperation(token);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await action(token);
  } finally {
    signal?.removeEventListener('abort', cancel);
    native.finishWorkspaceOperation(token);
  }
}

function boolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new LocalToolInputError(`${key} must be a boolean.`);
  }
  return value;
}

export function isFileTool(name: string): name is FileToolName {
  return FILE_TOOL_DEFINITIONS.some((tool) => tool.definition.function.name === name);
}

function mutationRevision(
  args: Record<string, unknown>,
  observedRevision: string | undefined,
  required = false,
): string | null {
  if (!Object.hasOwn(args, 'expected_revision') && observedRevision !== undefined) {
    return observedRevision;
  }
  return expectedRevision(args, required);
}

export async function executeFileTool(
  workspaceId: string,
  name: string,
  input: unknown,
  native: FileToolPort,
  observedRevision?: string,
  versions: ReadonlyMap<string, string> = new Map(),
  signal?: AbortSignal,
): Promise<unknown> {
  switch (name) {
    case 'list_directory': {
      const args = argumentsRecord(input, ['path', 'limit']);
      return native.listWorkspaceFiles(
        workspaceId,
        args['path'] === undefined ? '' : text(args, 'path', 4096, 0),
        integer(args, 'limit', LIST_DIRECTORY_DEFAULT_LIMIT, 1, LIST_DIRECTORY_MAX_LIMIT),
      );
    }
    case 'read_file': {
      const args = argumentsRecord(input, ['path', 'offset', 'limit']);
      return native.readWorkspaceFile(
        workspaceId,
        text(args, 'path'),
        integer(args, 'offset', 0, 0, 4 * 1024 * 1024),
        integer(args, 'limit', READ_FILE_DEFAULT_BYTES, 1, READ_FILE_MAX_BYTES),
      );
    }
    case 'write_file': {
      const args = argumentsRecord(input, ['path', 'content', 'expected_revision']);
      const path = text(args, 'path');
      const revision = await native.writeWorkspaceFile(
        workspaceId,
        path,
        text(args, 'content', 4 * 1024 * 1024, 0),
        mutationRevision(args, observedRevision),
      );
      return { path, revision };
    }
    case 'edit_file': {
      const args = argumentsRecord(input, ['path', 'old_text', 'new_text', 'expected_revision']);
      const path = text(args, 'path');
      const revision = mutationRevision(args, observedRevision, true);
      if (!revision) {
        throw new LocalToolInputError('A file revision is required.');
      }
      const next = await native.editWorkspaceFile(
        workspaceId,
        path,
        text(args, 'old_text', 4 * 1024 * 1024),
        text(args, 'new_text', 4 * 1024 * 1024, 0),
        revision,
      );
      return { path, revision: next };
    }
    case 'rename_path': {
      const args = argumentsRecord(input, ['path', 'destination', 'expected_revision']);
      const path = text(args, 'path');
      const destination = text(args, 'destination');
      await native.renameWorkspacePath(
        workspaceId,
        path,
        destination,
        mutationRevision(args, observedRevision),
      );
      return { path, destination };
    }
    case 'delete_path': {
      const args = argumentsRecord(input, ['path', 'expected_revision']);
      const path = text(args, 'path');
      await native.removeWorkspacePath(workspaceId, path, mutationRevision(args, observedRevision));
      return { path, removed: true };
    }
    case 'search_files':
      return executeSearch(workspaceId, input, native, signal);
    case 'glob_files': {
      const args = argumentsRecord(input, ['pattern', 'path', 'file_type', 'offset', 'limit']);
      const options = searchOptions(args);
      options.include = args['pattern'] === undefined ? '**/*' : text(args, 'pattern', 1024);
      return operation(native, signal, (token) =>
        native.queryWorkspaceFiles(workspaceId, null, options, token),
      );
    }
    case 'apply_patch': {
      const args = argumentsRecord(input, ['patch']);
      const patch = text(args, 'patch', 4 * 1024 * 1024);
      const revisions = patchRevisions(patch, versions);
      return operation(native, signal, (token) =>
        native.applyWorkspacePatch(workspaceId, patch, revisions, token),
      );
    }
    default:
      throw new LocalToolInputError('This local tool is not available.');
  }

  function executeSearch(
    workspaceId: string,
    input: unknown,
    native: FileToolPort,
    signal?: AbortSignal,
  ) {
    const args = argumentsRecord(input, [
      'query',
      'path',
      'include',
      'file_type',
      'regex',
      'case_sensitive',
      'offset',
      'limit',
    ]);
    const query = text(args, 'query', 1024);
    if (Object.keys(args).length === 1 && !signal) {
      return native.searchWorkspaceFiles(workspaceId, query);
    }
    const options = searchOptions(args);
    return operation(native, signal, (token) =>
      native.queryWorkspaceFiles(workspaceId, query, options, token),
    );
  }

  function searchOptions(args: Record<string, unknown>) {
    return {
      path: args['path'] === undefined ? '' : text(args, 'path', 4096, 0),
      include: args['include'] === undefined ? '**/*' : text(args, 'include', 1024),
      fileType: args['file_type'] === undefined ? '' : text(args, 'file_type', 32),
      regex: boolean(args, 'regex', false),
      caseSensitive: boolean(args, 'case_sensitive', true),
      offset: integer(args, 'offset', 0, 0, 10_000),
      limit: integer(args, 'limit', 20, 1, 100),
    };
  }
}
