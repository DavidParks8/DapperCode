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
>;

export function isFileTool(name: string): name is FileToolName {
  return FILE_TOOL_DEFINITIONS.some((definition) => definition.function.name === name);
}

export async function executeFileTool(
  workspaceId: string,
  name: string,
  input: unknown,
  native: FileToolPort,
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
        expectedRevision(args),
      );
      return { path, revision };
    }
    case 'edit_file': {
      const args = argumentsRecord(input, ['path', 'old_text', 'new_text', 'expected_revision']);
      const path = text(args, 'path');
      const revision = expectedRevision(args, true);
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
      await native.renameWorkspacePath(workspaceId, path, destination, expectedRevision(args));
      return { path, destination };
    }
    case 'delete_path': {
      const args = argumentsRecord(input, ['path', 'expected_revision']);
      const path = text(args, 'path');
      await native.removeWorkspacePath(workspaceId, path, expectedRevision(args));
      return { path, removed: true };
    }
    case 'search_files': {
      const args = argumentsRecord(input, ['query']);
      return native.searchWorkspaceFiles(workspaceId, text(args, 'query', 1024));
    }
    default:
      throw new LocalToolInputError('This local tool is not available.');
  }
}
