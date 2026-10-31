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
import type { GitRemoteState, GitStatusWithRemote } from '../../workspace/api/protocol';

interface UseGitScreenDerivedArgs {
  status: GitStatusWithRemote | null;
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
  remote: GitRemoteState | null;
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
  | 'pushBlockedReason'
>;

/** Why pushing is impossible right now, from host-reported remote state. */
export function gitPushBlockedReason(remote: GitRemoteState | null): string | null {
  if (!remote) {
    return null;
  }
  if (!remote.hasOrigin) {
    return 'This repository has no origin remote, so there is nowhere to push.';
  }
  if (remote.unborn) {
    return 'Make a first commit before pushing.';
  }
  if (remote.detached) {
    return 'Switch to a branch to push.';
  }
  if (remote.network === 'offline') {
    return "You're offline. Connect to the internet to push.";
  }
  return null;
}

/** Why fetching (and so pulling) is impossible right now. */
export function gitFetchBlockedReason(remote: GitRemoteState | null): string | null {
  if (!remote) {
    return null;
  }
  if (!remote.hasOrigin) {
    return 'Add an origin remote to fetch and pull.';
  }
  if (remote.network === 'offline') {
    return "You're offline. Connect to the internet to fetch or pull.";
  }
  return null;
}

export function gitPullBlockedReason(remote: GitRemoteState | null): string | null {
  const fetchReason = gitFetchBlockedReason(remote);
  if (fetchReason || !remote) {
    return fetchReason;
  }
  if (remote.detached) {
    return 'Switch to a branch to pull.';
  }
  if (!remote.upstream) {
    return 'This branch has no upstream yet. Push it to publish it first.';
  }
  return null;
}

/**
 * Upstream tracking from host-reported remote state when present, otherwise from the porcelain
 * `## branch...upstream [ahead n, behind m]` header the bridge sends in `raw`.
 */
export function deriveUpstreamState(status: GitStatusWithRemote | null) {
  const remote = status?.remote ?? null;
  const raw = status?.raw ?? '';
  return {
    remote,
    aheadCount: remote?.ahead ?? parseAheadCount(raw),
    behindCount: remote?.behind ?? parseBehindCount(raw),
    hasUpstream: remote ? remote.upstream !== null : parseHasUpstream(raw),
    upstreamBranch: remote ? remote.upstream : parseUpstreamBranch(raw),
  };
}

function formatOrigin(origin: string | null): string | null {
  if (!origin) {
    return null;
  }
  return origin.replace(/^https?:\/\//u, '').replace(/\.git$/u, '');
}

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

function computeUpstreamDisplay(
  remote: GitRemoteState | null,
  upstreamBranch: string | null,
  canPublishBranch: boolean,
): string | null {
  if (remote && !remote.hasOrigin) {
    return 'No remote';
  }
  return upstreamBranch ?? (canPublishBranch ? 'Not published' : null);
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

  const { remote } = inputs;
  const pushBlockedReason = gitPushBlockedReason(remote);
  const canPush = aheadCount > 0;
  const canPublishBranch = !hasUpstream && isPublishableBranch(status?.branch);

  return {
    latestCommit: history[0] ?? null,
    canPush,
    canPublishBranch,
    // A blocked push stays visible (disabled, with its reason) so the user learns why.
    showPushAction: canPush || canPublishBranch,
    commitButtonDisabled: committing || !commitMessage.trim() || !hasStagedFiles,
    pushButtonDisabled: pushing || committing || loading || Boolean(pushBlockedReason),
    pushBlockedReason,
    upstreamDisplay: computeUpstreamDisplay(remote, upstreamBranch, canPublishBranch),
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
  const { remote, aheadCount, behindCount, hasUpstream, upstreamBranch } = useMemo(
    () => deriveUpstreamState(status),
    [status],
  );
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
    pushBlockedReason,
  } = computeGitActionState({
    status,
    remote,
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
    pushBlockedReason,
    remote,
    fetchBlockedReason: gitFetchBlockedReason(remote),
    pullBlockedReason: gitPullBlockedReason(remote),
    originDisplay: formatOrigin(remote?.origin ?? null),
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
