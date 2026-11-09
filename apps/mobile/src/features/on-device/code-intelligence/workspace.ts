import type { OnDeviceNativeServices } from '../native/services.types';
import { LocalToolInputError } from '../runtime/toolArguments';

export type CodeWorkspacePort = Pick<
  OnDeviceNativeServices,
  'listWorkspaceFiles' | 'readWorkspaceFile' | 'writeWorkspaceFile' | 'getWorkspaceChangeToken'
>;

export const CODE_LIMITS = {
  fileBytes: 65_536,
  projectBytes: 524_288,
  files: 64,
  entries: 512,
  depth: 12,
  milliseconds: 5_000,
  results: 40,
  outputCharacters: 8_192,
} as const;

export class LocalCodeError extends Error {
  constructor(
    readonly code:
      'CODE_BUDGET' | 'CODE_CANCELLED' | 'CODE_WORKSPACE_CHANGED' | 'CODE_FORMAT_PARSE',
    message: string,
  ) {
    super(message);
    this.name = 'LocalCodeError';
  }
}

export function codeOperation(signal?: AbortSignal): {
  check: () => void;
  yield: () => Promise<void>;
} {
  const deadline = Date.now() + CODE_LIMITS.milliseconds;
  const check = () => {
    if (signal?.aborted) {
      throw new LocalCodeError('CODE_CANCELLED', 'Code tool cancelled.');
    }
    if (Date.now() > deadline) {
      throw new LocalCodeError(
        'CODE_BUDGET',
        'Code tool exceeded its 5-second cooperative budget.',
      );
    }
  };
  return {
    check,
    yield: async () => {
      check();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      check();
    },
  };
}

export function codePath(path: string): string {
  if (
    path.length > 256 ||
    path.includes('\\') ||
    /[\u0000-\u001f]/u.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
  ) {
    throw new LocalToolInputError('Use a workspace-relative file path, at most 256 characters.');
  }
  return path;
}

export function isScript(path: string): boolean {
  return /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(path);
}

export async function readCodeFile(
  native: CodeWorkspacePort,
  workspace: string,
  path: string,
  operation: ReturnType<typeof codeOperation>,
): Promise<{ content: string; revision: string; bytes: number }> {
  await operation.yield();
  const file = await native.readWorkspaceFile(workspace, path, 0, CODE_LIMITS.fileBytes);
  operation.check();
  if (file.nextOffset !== null || file.totalBytes > CODE_LIMITS.fileBytes) {
    throw new LocalCodeError('CODE_BUDGET', `File ${path} exceeds the 64 KiB code-tool limit.`);
  }
  return { content: file.content, revision: file.revision, bytes: file.totalBytes };
}

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '.expo', 'dist', 'build', 'Pods']);

export async function codeSnapshot(
  native: CodeWorkspacePort,
  workspace: string,
  operation: ReturnType<typeof codeOperation>,
): Promise<Map<string, { content: string; revision: string }>> {
  const token = await native.getWorkspaceChangeToken(workspace);
  const files = new Map<string, { content: string; revision: string }>();
  const directories = [{ path: '', depth: 0 }];
  let entries = 0;
  let bytes = 0;
  for (const directory of directories) {
    await operation.yield();
    const listing = await native.listWorkspaceFiles(workspace, directory.path, CODE_LIMITS.entries);
    operation.check();
    entries += listing.entries.length;
    if (listing.truncated || entries > CODE_LIMITS.entries) {
      throw new LocalCodeError('CODE_BUDGET', 'Workspace exceeds the 512-entry code-tool budget.');
    }
    for (const entry of listing.entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const path = codePath(directory.path ? `${directory.path}/${entry.name}` : entry.name);
      if (entry.kind === 'directory') {
        if (directory.depth >= CODE_LIMITS.depth) {
          throw new LocalCodeError(
            'CODE_BUDGET',
            'Workspace exceeds the 12-directory depth budget.',
          );
        }
        directories.push({ path, depth: directory.depth + 1 });
      } else if (entry.kind === 'file' && isScript(path)) {
        if (entry.bytes > CODE_LIMITS.fileBytes || files.size >= CODE_LIMITS.files) {
          throw new LocalCodeError(
            'CODE_BUDGET',
            'Code project exceeds 64 files, 64 KiB per file, or 512 KiB total.',
          );
        }
        const file = await readCodeFile(native, workspace, path, operation);
        bytes += file.bytes;
        if (bytes > CODE_LIMITS.projectBytes) {
          throw new LocalCodeError('CODE_BUDGET', 'Code project exceeds 512 KiB total source.');
        }
        files.set(path, file);
      }
      // Native listings identify symbolic links; never follow them, even inside the workspace.
    }
  }
  operation.check();
  if ((await native.getWorkspaceChangeToken(workspace)) !== token) {
    throw new LocalCodeError('CODE_WORKSPACE_CHANGED', 'Workspace changed during analysis. Retry.');
  }
  return files;
}

export function boundedCodeResults<T>(items: T[], metadata: object): object {
  const results: T[] = [];
  let truncated = false;
  for (const item of items) {
    results.push(item);
    if (
      results.length > CODE_LIMITS.results ||
      JSON.stringify({ ...metadata, results, truncated: false }).length >
        CODE_LIMITS.outputCharacters
    ) {
      results.pop();
      truncated = true;
      break;
    }
  }
  return { ...metadata, results, truncated };
}
