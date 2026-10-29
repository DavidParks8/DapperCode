import type { OnDeviceNativeServices } from '../native/services.types';
import { argumentsRecord, LocalToolInputError, text } from '../runtime/toolArguments';
import { toolDefinition } from '../runtime/toolDefinition';

export const GIT_TOOL_DEFINITIONS = [
  toolDefinition(
    'git_status',
    'Read workspace Git status. Large results are explicitly truncated.',
    {},
    [],
  ),
  toolDefinition(
    'git_diff',
    'Read separately labelled staged (HEAD to index) and unstaged (index to working tree) patches within one shared output budget.',
    {},
    [],
  ),
  toolDefinition('git_history', 'Read recent workspace commits.', {}, []),
  toolDefinition(
    'git_stage',
    'Stage a literal file path, or omit path to stage all non-ignored changes.',
    { path: { type: 'string' } },
    [],
  ),
  toolDefinition(
    'git_commit',
    'Commit staged changes using the configured author identity.',
    { message: { type: 'string' } },
    ['message'],
  ),
  toolDefinition(
    'git_push',
    'Push the current branch to its configured origin. Requires network and configured sign-in.',
    {},
    [],
  ),
];

export interface LocalGitIdentity {
  name: string;
  email: string;
}

export type GitToolPort = Pick<
  OnDeviceNativeServices,
  | 'getWorkspaceGitStatus'
  | 'getWorkspaceGitDiff'
  | 'getWorkspaceGitHistory'
  | 'stageWorkspaceGit'
  | 'commitWorkspaceGit'
  | 'pushWorkspaceGit'
>;

export function isGitTool(name: string): boolean {
  return GIT_TOOL_DEFINITIONS.some((definition) => definition.function.name === name);
}

export async function executeGitTool(
  workspaceId: string,
  name: string,
  input: unknown,
  native: GitToolPort,
  author: () => LocalGitIdentity | null,
  credentials: (workspaceId: string) => Promise<string | null>,
): Promise<unknown> {
  if (name === 'git_stage') {
    const args = argumentsRecord(input, ['path']);
    const path = args['path'] === undefined ? null : text(args, 'path');
    await native.stageWorkspaceGit(workspaceId, path);
    return { staged: true, path };
  }
  if (name === 'git_commit') {
    const args = argumentsRecord(input, ['message']);
    const identity = author();
    if (!identity?.name.trim() || !identity.email.trim()) {
      throw new Error(
        'Set your Git author name and email in on-device account settings before committing.',
      );
    }
    const hash = await native.commitWorkspaceGit(
      workspaceId,
      text(args, 'message', 10_000),
      identity.name,
      identity.email,
    );
    return { hash };
  }
  argumentsRecord(input, []);
  switch (name) {
    case 'git_status': {
      const status = await native.getWorkspaceGitStatus(workspaceId);
      const files = status.files.slice(0, 20);
      return {
        branch: status.branch,
        clean: status.clean,
        files,
        totalFiles: status.totalFiles,
        omittedFiles: status.totalFiles - files.length,
        maxFiles: 20,
        truncated: status.truncated || status.totalFiles > files.length,
      };
    }
    case 'git_diff':
      return native.getWorkspaceGitDiff(workspaceId, 4096);
    case 'git_history': {
      const history = await native.getWorkspaceGitHistory(workspaceId);
      return { commits: history.commits.slice(0, 10), truncated: history.commits.length > 10 };
    }
    case 'git_push':
      await native.pushWorkspaceGit(workspaceId, await credentials(workspaceId));
      return { pushed: true };
    default:
      throw new LocalToolInputError('This local Git tool is not available.');
  }
}
