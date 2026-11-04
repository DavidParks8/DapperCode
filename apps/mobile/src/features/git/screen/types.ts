import type { GitBranchSummary, GitHistoryCommit } from '@bridge/types/types';
import type { GitRemoteState } from '../../workspace/api/protocol';
import type { UnifiedDiffDocument } from '../diff/unified';
import type { ChangedFileEntry } from './utils';

export interface GitChangedFileWithStats extends ChangedFileEntry {
  stats: { additions: number; deletions: number } | null;
  diffFileId: string | null;
}

export interface GitScreenDerivedState {
  hasWorkspace: boolean;
  workspaceChanged: boolean;
  changedFiles: ChangedFileEntry[];
  changedFilesWithStats: GitChangedFileWithStats[];
  parsedDiff: UnifiedDiffDocument;
  truncationNotice: string;
  hasChanges: boolean;
  hasStagedFiles: boolean;
  hasUnstagedFiles: boolean;
  aheadCount: number;
  behindCount: number;
  hasUpstream: boolean;
  upstreamBranch: string | null;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  latestCommit: GitHistoryCommit | null;
  canPush: boolean;
  canPublishBranch: boolean;
  showPushAction: boolean;
  commitButtonDisabled: boolean;
  pushButtonDisabled: boolean;
  upstreamDisplay: string | null;
  syncDisplay: string | null;
  reviewTitle: string;
  reviewDetail: string;
  reviewHighlights: GitChangedFileWithStats[];
  pushButtonLabel: string;
  branchSwitchDisabled: boolean;
  /** Host-reported remote state; null for hosts that only send the porcelain header. */
  remote: GitRemoteState | null;
  pushBlockedReason: string | null;
  fetchBlockedReason: string | null;
  pullBlockedReason: string | null;
  /** Origin without scheme or `.git`, such as `github.com/owner/repo`. */
  originDisplay: string | null;
  branchRows: GitBranchSummary[];
  filesListMaxHeight: number;
  diffViewerMaxHeight: number;
}
