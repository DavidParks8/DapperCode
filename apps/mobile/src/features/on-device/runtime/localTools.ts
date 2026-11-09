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
import { ARTIFACT_TOOL_DEFINITIONS } from './toolArtifacts';

const LOCAL_TOOLS = [
  ...FILE_TOOL_DEFINITIONS,
  ...GIT_TOOL_DEFINITIONS,
  ...WEB_TOOL_DEFINITIONS,
  ...SEARCH_TOOL_DEFINITIONS,
  ...ARTIFACT_TOOL_DEFINITIONS,
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

/**
 * Small local models otherwise treat an empty workspace search as proof that something is absent.
 * It deliberately does not say to search the web: that made models send this project's own symbols
 * to the web. Research guidance lives in the system prompt.
 */
export const EMPTY_WORKSPACE_SEARCH_NOTE =
  'No workspace matches. That only means this workspace does not mention it, not that it does not exist.';

function withEmptySearchNote(result: unknown): unknown {
  return isRecord(result) && Array.isArray(result['matches']) && result['matches'].length === 0
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
  return (workspace, name, input, signal, offload) => {
    if (name === 'web_fetch') {
      requireNetwork('fetch web pages');
      return executeWebFetch(input, signal, undefined, offload);
    }
    if (name === 'web_search') {
      requireNetwork('search the web');
      return executeWebSearch(input, signal, undefined, offload);
    }
    if (isFileTool(name)) {
      let versions: Map<string, string> | undefined;
      if (signal) {
        let workspaces = observed.get(signal);
        if (!workspaces) {
          workspaces = new Map();
          observed.set(signal, workspaces);
        }
        versions = workspaces.get(workspace);
        if (!versions) {
          versions = new Map();
          workspaces.set(workspace, versions);
        }
      }
      const args = isRecord(input) ? input : null;
      const path = typeof args?.['path'] === 'string' ? args['path'] : null;
      const revision = path === null ? undefined : versions?.get(path);
      return executeFileTool(workspace, name, input, native, revision).then((result) => {
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
    }
    if (isGitTool(name)) {
      return executeGitTool(workspace, name, input, native, author, credential, offload);
    }
    return Promise.reject(new Error('The model requested a tool that is not available.'));
  };
}
