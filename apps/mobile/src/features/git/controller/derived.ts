import { useMemo } from 'react';

import type {
  GitBranchSummary,
  GitDiffResponse,
  GitHistoryCommit,
  GitStatusResponse,
} from '@bridge/types/types';
import { parseUnifiedGitDiff } from '../diff/unified';
import type { UnifiedDiffFile } from '../diff/unified';
import {
  findDiffFileIdForEntry,
  isPublishableBranch,
  mapStatusFileToChangedEntry,
  parseAheadCount,
  parseBehindCount,
  parseChangedFiles,
  parseHasUpstream,
  parseUpstreamBranch,
  formatSyncDisplay,
} from '../screen/utils';
import type { GitScreenDerivedState } from '../screen/types';

interface UseGitScreenDerivedArgs {
  status: GitStatusResponse | null;
  diff: GitDiffResponse | null;
  history: GitHistoryCommit[];
  branches: GitBranchSummary[];
  branchDraft: string;
  commitMessage: string;
  workspaceDraft: string;
  workspaceCwd: string;
  loading: boolean;
  committing: boolean;
  pushing: boolean;
  switchingBranch: boolean;
  windowHeight: number;
}

interface GitActionStateInputs {
  status: GitStatusResponse | null;
  history: GitHistoryCommit[];
  changedFiles: ReturnType<typeof parseChangedFiles>;
  changedFilesWithStats: GitScreenDerivedState['changedFilesWithStats'];
  hasChanges: boolean;
  hasStagedFiles: boolean;
  aheadCount: number;
  behindCount: number;
  hasUpstream: boolean;
  upstreamBranch: string | null;
  stagedCount: number;
  unstagedCount: number;
  commitMessage: string;
  committing: boolean;
  pushing: boolean;
  loading: boolean;
  switchingBranch: boolean;
  branchDraft: string;
}

type GitActionState = Pick<
  GitScreenDerivedState,
  | 'latestCommit'
  | 'canPush'
  | 'canPublishBranch'
  | 'showPushAction'
  | 'commitButtonDisabled'
  | 'pushButtonDisabled'
  | 'upstreamDisplay'
  | 'syncDisplay'
  | 'reviewTitle'
  | 'reviewDetail'
  | 'reviewHighlights'
  | 'pushButtonLabel'
  | 'branchSwitchDisabled'
>;

function computeGitReviewTitle(
  status: GitStatusResponse | null,
  hasStagedFiles: boolean,
  hasChanges: boolean,
): string {
  if (status?.clean) {
    return 'Working tree clean';
  }
  if (hasStagedFiles) {
    return 'Ready to commit';
  }
  return hasChanges ? 'Review and stage' : 'No changes';
}

function computeGitReviewDetail(
  status: GitStatusResponse | null,
  hasStagedFiles: boolean,
  changedFilesCount: number,
  stagedCount: number,
  unstagedCount: number,
): string {
  if (status?.clean) {
    return 'There are no local changes in this workspace.';
  }
  if (hasStagedFiles) {
    return `${String(stagedCount)} staged, ${String(unstagedCount)} unstaged.`;
  }
  return `${String(changedFilesCount)} changed file${changedFilesCount === 1 ? '' : 's'}. Stage the ones you want to commit.`;
}

function computeGitPushButtonLabel(
  pushing: boolean,
  canPublishBranch: boolean,
  aheadCount: number,
): string {
  if (pushing) {
    return canPublishBranch ? 'Publishing...' : 'Pushing...';
  }
  return canPublishBranch ? 'Publish branch' : `Push (${aheadCount})`;
}

function computeBranchSwitchDisabled(
  switchingBranch: boolean,
  loading: boolean,
  branchDraft: string,
  statusBranch: string | undefined,
): boolean {
  return (
    switchingBranch || loading || !branchDraft.trim() || branchDraft.trim() === (statusBranch ?? '')
  );
}

function computeGitActionState(inputs: GitActionStateInputs): GitActionState {
  const {
    status,
    history,
    changedFiles,
    changedFilesWithStats,
    hasChanges,
    hasStagedFiles,
    aheadCount,
    behindCount,
    hasUpstream,
    upstreamBranch,
    stagedCount,
    unstagedCount,
    commitMessage,
    committing,
    pushing,
    loading,
    switchingBranch,
    branchDraft,
  } = inputs;

  const canPush = aheadCount > 0;
  const canPublishBranch = !hasUpstream && isPublishableBranch(status?.branch);

  return {
    latestCommit: history[0] ?? null,
    canPush,
    canPublishBranch,
    showPushAction: canPush || canPublishBranch,
    commitButtonDisabled: committing || !commitMessage.trim() || !hasStagedFiles,
    pushButtonDisabled: pushing || committing || loading,
    upstreamDisplay: upstreamBranch ?? (canPublishBranch ? 'Not published' : null),
    syncDisplay: formatSyncDisplay(aheadCount, behindCount),
    reviewTitle: computeGitReviewTitle(status, hasStagedFiles, hasChanges),
    reviewDetail: computeGitReviewDetail(
      status,
      hasStagedFiles,
      changedFiles.length,
      stagedCount,
      unstagedCount,
    ),
    reviewHighlights: changedFilesWithStats.slice(0, 3),
    pushButtonLabel: computeGitPushButtonLabel(pushing, canPublishBranch, aheadCount),
    branchSwitchDisabled: computeBranchSwitchDisabled(
      switchingBranch,
      loading,
      branchDraft,
      status?.branch,
    ),
  };
}

export function useGitScreenDerived(args: UseGitScreenDerivedArgs): GitScreenDerivedState {
  const {
    status,
    diff,
    history,
    branches,
    branchDraft,
    commitMessage,
    workspaceDraft,
    workspaceCwd,
    loading,
    committing,
    pushing,
    switchingBranch,
    windowHeight,
  } = args;

  const changedFiles = useMemo(() => {
    if (status?.files?.length) {
      return status.files.map(mapStatusFileToChangedEntry);
    }
    return parseChangedFiles(status?.raw ?? '');
  }, [status?.files, status?.raw]);

  const parsedDiff = useMemo(() => parseUnifiedGitDiff(diff?.diff ?? ''), [diff?.diff]);

  const diffStatsByPath = useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number }>();
    for (const file of parsedDiff.files) {
      const stats = { additions: file.additions, deletions: file.deletions };
      for (const key of getDiffFileLookupKeys(file)) {
        map.set(key, stats);
      }
    }
    return map;
  }, [parsedDiff.files]);

  const changedFilesWithStats = useMemo(
    () =>
      changedFiles.map((entry) => ({
        ...entry,
        stats: diffStatsByPath.get(entry.path) ?? null,
        diffFileId: findDiffFileIdForEntry(entry, parsedDiff.files),
      })),
    [changedFiles, diffStatsByPath, parsedDiff.files],
  );

  const truncationNotice = useMemo(() => {
    const notices: string[] = [];
    if (status?.truncated) {
      notices.push(
        `Showing ${String(status.files.length)} of ${String(status.totalFiles)} changed files.`,
      );
    }
    if (diff?.truncated) {
      notices.push(`Diff preview is limited to ${String(Math.round(diff.maxBytes / 1024))} KB.`);
    }
    return notices.join(' ');
  }, [diff, status]);

  const hasChanges = changedFiles.length > 0;
  const hasStagedFiles = useMemo(() => changedFiles.some((entry) => entry.staged), [changedFiles]);
  const hasUnstagedFiles = useMemo(
    () => changedFiles.some((entry) => entry.unstaged),
    [changedFiles],
  );
  const aheadCount = useMemo(() => parseAheadCount(status?.raw ?? ''), [status?.raw]);
  const behindCount = useMemo(() => parseBehindCount(status?.raw ?? ''), [status?.raw]);
  const hasUpstream = useMemo(() => parseHasUpstream(status?.raw ?? ''), [status?.raw]);
  const upstreamBranch = useMemo(() => parseUpstreamBranch(status?.raw ?? ''), [status?.raw]);
  const stagedCount = useMemo(
    () => changedFiles.filter((entry) => entry.staged).length,
    [changedFiles],
  );
  const unstagedCount = useMemo(
    () => changedFiles.filter((entry) => entry.unstaged).length,
    [changedFiles],
  );
  const untrackedCount = useMemo(
    () => changedFiles.filter((entry) => entry.untracked).length,
    [changedFiles],
  );
  const {
    latestCommit,
    canPush,
    canPublishBranch,
    showPushAction,
    commitButtonDisabled,
    pushButtonDisabled,
    upstreamDisplay,
    syncDisplay,
    reviewTitle,
    reviewDetail,
    reviewHighlights,
    pushButtonLabel,
    branchSwitchDisabled,
  } = computeGitActionState({
    status,
    history,
    changedFiles,
    changedFilesWithStats,
    hasChanges,
    hasStagedFiles,
    aheadCount,
    behindCount,
    hasUpstream,
    upstreamBranch,
    stagedCount,
    unstagedCount,
    commitMessage,
    committing,
    pushing,
    loading,
    switchingBranch,
    branchDraft,
  });
  const filesListMaxHeight = useMemo(
    () => Math.max(200, Math.min(360, Math.floor(windowHeight * 0.4))),
    [windowHeight],
  );
  const diffViewerMaxHeight = useMemo(
    () => Math.max(220, Math.min(480, Math.floor(windowHeight * 0.5))),
    [windowHeight],
  );

  return {
    hasWorkspace: Boolean(workspaceDraft.trim() || workspaceCwd),
    workspaceChanged: workspaceDraft.trim() !== workspaceCwd,
    changedFiles,
    changedFilesWithStats,
    parsedDiff,
    truncationNotice,
    hasChanges,
    hasStagedFiles,
    hasUnstagedFiles,
    aheadCount,
    behindCount,
    hasUpstream,
    upstreamBranch,
    stagedCount,
    unstagedCount,
    untrackedCount,
    latestCommit,
    canPush,
    canPublishBranch,
    showPushAction,
    commitButtonDisabled,
    pushButtonDisabled,
    upstreamDisplay,
    syncDisplay,
    reviewTitle,
    reviewDetail,
    reviewHighlights,
    pushButtonLabel,
    branchSwitchDisabled,
    branchRows: branches,
    filesListMaxHeight,
    diffViewerMaxHeight,
  };
}

function getDiffFileLookupKeys(file: UnifiedDiffFile): string[] {
  const keys = [file.displayPath, file.oldPath, file.newPath].filter((value): value is string =>
    Boolean(value),
  );
  return Array.from(new Set(keys));
}
