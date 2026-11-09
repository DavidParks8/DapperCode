import { executeGitTool, GIT_TOOL_DEFINITIONS, isGitTool } from '../git/gitTools';
import type { ChatToolKind } from '@bridge/types/types';
import type { LocalGitIdentity } from '../git/gitTools';
import type { OnDeviceNativeServices } from '../native/services.types';
import { FILE_TOOL_DEFINITIONS } from '../workspaces/fileToolDefinitions';
import { executeFileTool, isFileTool } from '../workspaces/fileTools';
import type { LocalToolApprovalPolicy, LocalToolExecutor } from './agentLoop';
import { executeWebFetch, WEB_TOOL_DEFINITIONS } from './webFetch';
import { executeWebSearch, SEARCH_TOOL_DEFINITIONS } from './webSearch';
import { LocalToolInputError } from './toolArguments';
import { isRecord } from '@shared/records';
import { SKILL_TOOL_DEFINITIONS } from './skillTool';
export { LocalWorkspaceGuidance } from './workspaceGuidance';
import { CODE_TOOL_DEFINITIONS, isCodeTool } from '../code-intelligence/definitions';
import type * as CodeTools from '../code-intelligence/tools';
import { PARALLEL_READ_TOOLS, READ_CHILD_TOOL, TASK_TOOL } from './delegation';
import { ARTIFACT_TOOL_DEFINITIONS } from './toolArtifacts';
import { INTERACTION_TOOL_DEFINITIONS } from './interactionTools';
import { formatAfterFileEdit } from '../code-intelligence/formatAfterFileEdit';
import { isFormattable } from '../code-intelligence/workspace';

const LOCAL_TOOLS = [
  ...FILE_TOOL_DEFINITIONS,
  ...GIT_TOOL_DEFINITIONS,
  ...WEB_TOOL_DEFINITIONS,
  ...SEARCH_TOOL_DEFINITIONS,
  ...SKILL_TOOL_DEFINITIONS,
  ...CODE_TOOL_DEFINITIONS,
  TASK_TOOL,
  READ_CHILD_TOOL,
  ...ARTIFACT_TOOL_DEFINITIONS,
  ...INTERACTION_TOOL_DEFINITIONS,
];
const TOOL_REGISTRY = new Map<string, (typeof LOCAL_TOOLS)[number]>(
  LOCAL_TOOLS.map((tool) => [tool.definition.function.name, tool]),
);

export const LOCAL_TOOL_DEFINITIONS: object[] = LOCAL_TOOLS.map((tool) => tool.definition);

export function localToolKind(name: string): ChatToolKind {
  return TOOL_REGISTRY.get(name)?.kind ?? 'other';
}

export const localToolApproval: LocalToolApprovalPolicy = (name, input) => {
  const tool = TOOL_REGISTRY.get(name);
  if (!tool) {
    throw new LocalToolInputError('This local tool is not available.');
  }
  return tool.approval ? { kind: tool.kind, summary: tool.approval(input) } : null;
};

function forgetPathVersions(versions: Map<string, string>, path: string): void {
  for (const knownPath of versions.keys()) {
    if (knownPath === path || knownPath.startsWith(`${path}/`)) {
      versions.delete(knownPath);
    }
  }
}

function workspaceVersions(
  observed: WeakMap<AbortSignal, Map<string, Map<string, string>>>,
  workspace: string,
  signal?: AbortSignal,
): Map<string, string> | undefined {
  if (!signal) {
    return undefined;
  }
  let workspaces = observed.get(signal);
  if (!workspaces) {
    workspaces = new Map();
    observed.set(signal, workspaces);
  }
  let versions = workspaces.get(workspace);
  if (!versions) {
    versions = new Map();
    workspaces.set(workspace, versions);
  }
  return versions;
}

function observePatchVersions(result: unknown, versions: Map<string, string> | undefined): void {
  if (!versions || !isRecord(result) || !Array.isArray(result['files'])) {
    return;
  }
  for (const file of result['files']) {
    if (isRecord(file) && typeof file['path'] === 'string') {
      forgetPathVersions(versions, file['path']);
      if (typeof file['revision'] === 'string') {
        versions.set(file['path'], file['revision']);
      }
    }
  }
}

/**
 * Small local models otherwise treat an empty workspace search as proof that something is absent.
 * It deliberately does not say to search the web: that made models send this project's own symbols
 * to the web. Research guidance lives in the system prompt.
 */
export const EMPTY_WORKSPACE_SEARCH_NOTE =
  'No workspace matches. That only means this workspace does not mention it, not that it does not exist.';

function withEmptySearchNote(result: unknown): unknown {
  return isRecord(result) &&
    result['truncated'] !== true &&
    Array.isArray(result['matches']) &&
    result['matches'].length === 0
    ? { ...result, note: EMPTY_WORKSPACE_SEARCH_NOTE }
    : result;
}

/** Routes model tool calls to workspace tools or the approved HTTPS reader. */
export function localToolExecutor(
  native: OnDeviceNativeServices,
  author: () => LocalGitIdentity | null,
  credential: (workspaceId: string) => Promise<string | null>,
  requireNetwork: (action: string) => void,
): LocalToolExecutor {
  // Each run owns its signal, so observations cannot leak across turns or workspaces.
  const observed = new WeakMap<AbortSignal, Map<string, Map<string, string>>>();
  let mutationTail: Promise<unknown> = Promise.resolve();
  const mutation = (signal: AbortSignal | undefined, work: () => Promise<unknown>) => {
    // Keep each child's captured revision when queuing, so a sibling edit still fails CAS.
    const result = mutationTail
      .catch(() => undefined)
      .then(() => {
        if (signal?.aborted) {
          throw new Error('Local mutation was stopped before execution.');
        }
        return work();
      });
    mutationTail = result;
    return result;
  };
  const dispatch = (name: string, signal: AbortSignal | undefined, work: () => Promise<unknown>) =>
    PARALLEL_READ_TOOLS.has(name) ? work() : mutation(signal, work);
  return (workspace, name, input, signal, offload) => {
    if (signal?.aborted) {
      return Promise.reject(new Error('Local tool work was stopped before execution.'));
    }
    if (name === 'web_fetch') {
      requireNetwork('fetch web pages');
      return executeWebFetch(input, signal, undefined, offload);
    }
    if (name === 'web_search') {
      requireNetwork('search the web');
      return executeWebSearch(input, signal, undefined, offload);
    }
    if (isFileTool(name) || isCodeTool(name)) {
      const versions = workspaceVersions(observed, workspace, signal);
      const args = isRecord(input) ? input : null;
      const path = typeof args?.['path'] === 'string' ? args['path'] : null;
      const revision = path === null ? undefined : versions?.get(path);
      const work = () => {
        let resultPromise: Promise<unknown>;
        if (isCodeTool(name)) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const code = require('../code-intelligence/tools') as typeof CodeTools;
          resultPromise = code.executeCodeTool(workspace, name, input, native, signal, revision);
        } else {
          resultPromise = executeFileTool(
            workspace,
            name,
            input,
            native,
            revision,
            versions,
            signal,
          ).then(async (result) => {
            if (name === 'write_file' || name === 'edit_file') {
              if (
                !isRecord(result) ||
                typeof result['path'] !== 'string' ||
                typeof result['revision'] !== 'string'
              ) {
                throw new Error(
                  'The completed file edit returned invalid metadata. Inspect the file; do not replay the edit.',
                );
              }
              const edit = { path: result['path'], revision: result['revision'] };
              versions?.set(edit.path, edit.revision);
              return formatAfterFileEdit(native, workspace, edit, signal);
            }
            if (name === 'apply_patch' && isRecord(result) && Array.isArray(result['files'])) {
              const files: unknown[] = [];
              for (const file of result['files']) {
                if (
                  isRecord(file) &&
                  typeof file['path'] === 'string' &&
                  typeof file['revision'] === 'string' &&
                  isFormattable(file['path'])
                ) {
                  files.push(
                    await formatAfterFileEdit(
                      native,
                      workspace,
                      { path: file['path'], revision: file['revision'] },
                      signal,
                    ),
                  );
                } else {
                  files.push(file);
                }
              }
              return { ...result, files };
            }
            return result;
          });
        }
        return resultPromise.then((result) => {
          if (name === 'apply_patch') {
            observePatchVersions(result, versions);
          }
          if (name === 'search_files') {
            return withEmptySearchNote(result);
          }
          if (!versions || path === null) {
            return result;
          }
          if (isRecord(result) && typeof result['revision'] === 'string') {
            versions.set(path, result['revision']);
          }
          if (name === 'rename_path' || name === 'delete_path') {
            const destination =
              name === 'rename_path' && typeof args?.['destination'] === 'string'
                ? args['destination']
                : null;
            forgetPathVersions(versions, path);
            if (destination !== null) {
              forgetPathVersions(versions, destination);
              if (revision !== undefined) {
                versions.set(destination, revision);
              }
            }
          }
          return result;
        });
      };
      return dispatch(name, signal, work);
    }
    if (isGitTool(name)) {
      const work = () =>
        executeGitTool(workspace, name, input, native, author, credential, offload);
      return dispatch(name, signal, work);
    }
    return Promise.reject(new Error('The model requested a tool that is not available.'));
  };
}
