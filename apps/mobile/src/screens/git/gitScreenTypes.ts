import type {
  GitBranchSummary,
  GitHistoryCommit,
} from '../../api/types';
import type { UnifiedDiffDocument } from './gitDiff';
import type { ChangedFileEntry } from './gitScreenUtils';

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
  branchRows: GitBranchSummary[];
  filesListMaxHeight: number;
  diffViewerMaxHeight: number;
}