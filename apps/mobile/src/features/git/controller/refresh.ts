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
  setBranchDraft: (value: string) => void;
}

export function applyGitRefreshSuccess(
  setters: GitRefreshSetters,
  nextStatus: GitStatusResponse,
  nextDiff: GitDiffResponse,
  nextHistory: GitHistoryResponse,
  nextBranches: GitBranchesResponse | null,
): void {
  setters.setStatus(nextStatus);
  setters.setDiff(nextDiff);
  setters.setHistory(nextHistory.commits);
  setters.setBranches(nextBranches?.branches ?? []);
  setters.setBranchDraft(nextBranches?.current ?? nextStatus.branch ?? '');
}
