import { executeGitTool, GIT_TOOL_DEFINITIONS, isGitTool } from '../git/gitTools';
import type { LocalGitIdentity } from '../git/gitTools';
import type { OnDeviceNativeServices } from '../native/services.types';
import { FILE_TOOL_DEFINITIONS } from '../workspaces/fileToolDefinitions';
import { executeFileTool, isFileTool } from '../workspaces/fileTools';
import type { LocalToolExecutor } from './agentLoop';

export const LOCAL_TOOL_DEFINITIONS: object[] = [...FILE_TOOL_DEFINITIONS, ...GIT_TOOL_DEFINITIONS];

/** Routes model tool calls to the native file and Git tools; anything else is rejected. */
export function localToolExecutor(
  native: OnDeviceNativeServices,
  author: () => LocalGitIdentity | null,
  credential: (workspaceId: string) => Promise<string | null>,
): LocalToolExecutor {
  return (workspace, name, input) => {
    if (isFileTool(name)) {
      return executeFileTool(workspace, name, input, native);
    }
    if (isGitTool(name)) {
      return executeGitTool(workspace, name, input, native, author, credential);
    }
    return Promise.reject(new Error('The model requested a tool that is not available.'));
  };
}
