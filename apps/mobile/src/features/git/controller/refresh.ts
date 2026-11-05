import type {
  GitBranchesResponse,
  GitBranchSummary,
  GitDiffResponse,
  GitHistoryCommit,
  GitHistoryResponse,
  GitStatusResponse,
} from '@bridge/types/types';

export function setGitRefreshLoadingState(
  initialLoad: boolean,
  setLoading: (value: boolean) => void,
  setRefreshing: (value: boolean) => void,
): void {
  if (initialLoad) {
    setLoading(true);
  } else {
    setRefreshing(true);
  }
}

export function shouldApplyGitRefreshResult(
  mountedRef: { current: boolean },
  refreshRequestIdRef: { current: number },
  requestedCwdRef: { current: string | undefined },
  requestId: number,
  requestCwd: string | undefined,
): boolean {
  return (
    mountedRef.current &&
    requestId === refreshRequestIdRef.current &&
    requestCwd === requestedCwdRef.current
  );
}

export interface GitRefreshSetters {
  setStatus: (value: GitStatusResponse) => void;
  setDiff: (value: GitDiffResponse) => void;
  setHistory: (value: GitHistoryCommit[]) => void;
  setBranches: (value: GitBranchSummary[]) => void;
  setBranchDraft: (value: string | ((current: string) => string)) => void;
}

export function reconcileGitBranchDraft(
  draft: string,
  previousBranch: string | null,
  nextBranch: string,
  available: readonly GitBranchSummary[] | null,
): string {
  if (
    !draft ||
    draft === previousBranch ||
    (available !== null && !available.some((branch) => branch.name === draft))
  ) {
    return nextBranch;
  }
  return draft;
}

export function applyGitRefreshSuccess(
  setters: GitRefreshSetters,
  nextStatus: GitStatusResponse,
  nextDiff: GitDiffResponse,
  nextHistory: GitHistoryResponse,
  nextBranches: GitBranchesResponse | null,
  previousBranch: string | null,
): void {
  setters.setStatus(nextStatus);
  setters.setDiff(nextDiff);
  setters.setHistory(nextHistory.commits);
  setters.setBranches(nextBranches?.branches ?? []);
  setters.setBranchDraft((draft) =>
    reconcileGitBranchDraft(
      draft,
      previousBranch,
      nextBranches?.current ?? nextStatus.branch ?? '',
      nextBranches?.branches ?? null,
    ),
  );
}
