import type { AgentId } from './typesChat';

export interface TerminalExecRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface TerminalExecResponse {
  command: string;
  cwd: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface GitHubAuthGrantInput {
  accessToken: string;
  repositories?: string[];
}

export interface GitHubAuthInstallResponse {
  installed: boolean;
  host: string;
  login: string | null;
  scopes: string[];
  credentialFile: string;
  grantsInstalled: number;
}

export interface GitStatusResponse {
  branch: string;
  clean: boolean;
  raw: string;
  files: GitStatusFile[];
  cwd?: string;
  truncated: boolean;
  totalFiles: number;
  omittedFiles: number;
  maxFiles: number;
  maxBytes: number;
}

export interface GitStatusFile {
  path: string;
  originalPath?: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitDiffResponse {
  diff: string;
  cwd?: string;
  truncated: boolean;
  originalBytes: number;
  returnedBytes: number;
  maxBytes: number;
}

export interface GitHistoryCommit {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authoredAt: string;
  refNames: string[];
  isHead: boolean;
}

export interface GitHistoryResponse {
  commits: GitHistoryCommit[];
  cwd?: string;
}

export interface GitBranchSummary {
  name: string;
  remote: boolean;
  current: boolean;
}

export interface GitBranchesResponse {
  branches: GitBranchSummary[];
  current?: string | null;
  cwd?: string;
}

export interface GitCloneRequest {
  url: string;
  parentPath?: string | null;
  directoryName: string;
}

export interface GitCloneResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  cloned: boolean;
  cwd?: string;
  url: string;
}

export interface GitFileRequest {
  path: string;
  cwd?: string;
}

export interface GitStageResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  staged: boolean;
  path: string;
  cwd?: string;
}

export interface GitStageAllResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  staged: boolean;
  cwd?: string;
}

export interface GitUnstageResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  unstaged: boolean;
  path: string;
  cwd?: string;
}

export interface GitUnstageAllResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  unstaged: boolean;
  cwd?: string;
}

export interface GitCommitRequest {
  message: string;
  cwd?: string;
}

export interface GitCommitResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  committed: boolean;
  cwd?: string;
}

export interface GitSwitchRequest {
  branch: string;
  cwd?: string;
}

export interface GitSwitchResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  switched: boolean;
  branch: string;
  cwd?: string;
}

export interface GitPushResponse {
  code: number | null;
  stdout: string;
  stderr: string;
  pushed: boolean;
  cwd?: string;
}

export type ApprovalKind = string;

export interface PendingApproval {
  requestId: string;
  agentId: AgentId;
  kind: ApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  title: string;
  message: string;
  requestedAt: string;
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  proposedExecpolicyAmendment?: string[];
  options: Array<{ id: string; label: string; kind?: string }>;
}

export interface ResolveApprovalResponse {
  ok: true;
  approval: PendingApproval;
  decision: string;
  resolutionId: string;
}

export interface UserInputQuestionOption {
  value: string;
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  required?: boolean;
  fieldType?: 'string' | 'integer' | 'number' | 'boolean' | 'string-array';
  defaultValue?: string | number | boolean | string[] | null;
  options: UserInputQuestionOption[] | null;
}

export interface PendingUserInputRequest {
  requestId: string;
  agentId: AgentId | null;
  threadId: string;
  turnId: string;
  itemId: string;
  message: string;
  requestedAt: string;
  questions: UserInputQuestion[];
}

export type UserInputValue = string | number | boolean | string[];

export interface ResolveUserInputRequest {
  answers: Record<string, UserInputValue>;
  action?: 'submit' | 'decline' | 'cancel';
}

export interface ResolveUserInputResponse {
  ok: true;
  request: PendingUserInputRequest;
}
