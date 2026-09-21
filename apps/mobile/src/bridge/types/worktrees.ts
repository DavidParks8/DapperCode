export interface ChatWorkspace {
  mode: 'local' | 'worktree';
  branch: string;
}

export interface ManagedWorktree {
  id: string;
  repository: string;
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
  status: 'creating' | 'ready' | 'removed';
}

export interface CreateManagedWorktree {
  id: string;
  cwd: string | null;
  branch: string;
  baseRef: string;
}
