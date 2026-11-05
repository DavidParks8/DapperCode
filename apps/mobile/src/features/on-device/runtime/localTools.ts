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

const LOCAL_TOOLS = [
  ...FILE_TOOL_DEFINITIONS,
  ...GIT_TOOL_DEFINITIONS,
  ...WEB_TOOL_DEFINITIONS,
  ...SEARCH_TOOL_DEFINITIONS,
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

/** Routes model tool calls to the native file and Git tools; anything else is rejected. */
export function localToolExecutor(
  native: OnDeviceNativeServices,
  author: () => LocalGitIdentity | null,
  credential: (workspaceId: string) => Promise<string | null>,
  requireNetwork: (action: string) => void,
): LocalToolExecutor {
  return (workspace, name, input, signal) => {
    if (name === 'web_fetch') {
      requireNetwork('fetch web pages');
      return executeWebFetch(input, signal);
    }
    if (name === 'web_search') {
      requireNetwork('search the web');
      return executeWebSearch(input, signal);
    }
    if (isFileTool(name)) {
      return executeFileTool(workspace, name, input, native);
    }
    if (isGitTool(name)) {
      return executeGitTool(workspace, name, input, native, author, credential);
    }
    return Promise.reject(new Error('The model requested a tool that is not available.'));
  };
}
