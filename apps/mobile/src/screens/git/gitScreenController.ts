import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, useWindowDimensions } from 'react-native';

import type { HostBridgeApiClient } from '../../api/client';
import type {
  ApprovalMode,
  Chat,
  GitBranchSummary,
  GitDiffResponse,
  GitHistoryCommit,
  GitStatusResponse,
} from '../../api/types';
import { useGitScreenDerived } from './gitScreenDerived';
import { useGitScreenReviewController } from './gitScreenReviewController';

interface UseGitScreenControllerArgs {
  api: HostBridgeApiClient;
  chat: Chat;
  approvalMode?: ApprovalMode;
  onBack: () => void;
  onChatUpdated?: (chat: Chat) => void;
}

export const GIT_SCREEN_REFRESH_INTERVAL_MS = 15_000;

export function useGitScreenController({
  api,
  chat,
  approvalMode,
  onBack,
  onChatUpdated,
}: UseGitScreenControllerArgs) {
  const [activeChat, setActiveChat] = useState(chat);
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  const [history, setHistory] = useState<GitHistoryCommit[]>([]);
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [branchDraft, setBranchDraft] = useState('');
  const [branchPanelOpen, setBranchPanelOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('chore: checkpoint');
  const [workspaceDraft, setWorkspaceDraft] = useState(chat.cwd ?? '');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingWorkspace, setSavingWorkspace] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState(false);
  const [stagingPath, setStagingPath] = useState<string | null>(null);
  const [unstagingPath, setUnstagingPath] = useState<string | null>(null);
  const [stagingAll, setStagingAll] = useState(false);
  const [unstagingAll, setUnstagingAll] = useState(false);
  const [bodyScrollEnabled, setBodyScrollEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const hasLoadedRef = useRef(false);
  const refreshRequestIdRef = useRef(0);
  const refreshInFlightRef = useRef(false);

  const { height: windowHeight } = useWindowDimensions();

  useEffect(() => {
    setActiveChat(chat);
    setWorkspaceDraft(chat.cwd ?? '');
    setBranches([]);
    setBranchDraft('');
    setBranchPanelOpen(false);
    setError(null);
  }, [chat]);

  const workspaceCwd = useMemo(() => activeChat.cwd?.trim() ?? '', [activeChat.cwd]);
  // Git reads and mutations must always target the committed activeChat.cwd, never the
  // editable workspaceDraft text. The draft only reflects in-progress typing until it is
  // saved via saveWorkspace(), at which point activeChat.cwd (and thus workspaceCwd) updates.
  const requestedCwd = useMemo(
    () => (workspaceCwd.length > 0 ? workspaceCwd : undefined),
    [workspaceCwd],
  );
  const requestedCwdRef = useRef(requestedCwd);
  requestedCwdRef.current = requestedCwd;

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestIdRef.current;
    const requestCwd = requestedCwd;
    const initialLoad = !hasLoadedRef.current;
    refreshInFlightRef.current = true;
    if (initialLoad) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    try {
      const [nextStatus, nextDiff, nextHistory, nextBranches] = await Promise.all([
        api.gitStatus(requestCwd),
        api.gitDiff(requestCwd),
        api.gitHistory(requestCwd, 12),
        api.gitBranches(requestCwd).catch(() => null),
      ]);
      if (
        !mountedRef.current ||
        requestId !== refreshRequestIdRef.current ||
        requestCwd !== requestedCwdRef.current
      ) {
        return;
      }
      setStatus(nextStatus);
      setDiff(nextDiff);
      setHistory(nextHistory.commits);
      setBranches(nextBranches?.branches ?? []);
      setBranchDraft(nextBranches?.current ?? nextStatus.branch ?? '');
      hasLoadedRef.current = true;
      setError(null);
    } catch (err) {
      if (
        mountedRef.current &&
        requestId === refreshRequestIdRef.current &&
        requestCwd === requestedCwdRef.current
      ) {
        setError((err as Error).message);
      }
    } finally {
      if (requestId === refreshRequestIdRef.current) {
        refreshInFlightRef.current = false;
        if (mountedRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
  }, [api, requestedCwd]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshRequestIdRef.current += 1;
      refreshInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    refreshRequestIdRef.current += 1;
    hasLoadedRef.current = false;
    setStatus(null);
    setDiff(null);
    setHistory([]);
    setBranches([]);
    setRefreshing(false);
    setLoading(true);
    void refresh();
  }, [refresh, requestedCwd]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    let active = AppState.currentState !== 'background' && AppState.currentState !== 'inactive';

    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };
    const start = () => {
      if (interval === null) {
        interval = setInterval(() => {
          if (!refreshInFlightRef.current) {
            void refreshRef.current();
          }
        }, GIT_SCREEN_REFRESH_INTERVAL_MS);
      }
    };

    if (active) {
      start();
    }
    const subscription = AppState.addEventListener('change', (nextState) => {
      const nextActive = nextState === 'active';
      if (nextActive) {
        if (!active && !refreshInFlightRef.current) {
          void refreshRef.current();
        }
        start();
      } else {
        stop();
        refreshRequestIdRef.current += 1;
        refreshInFlightRef.current = false;
        setRefreshing(false);
      }
      active = nextActive;
    });

    return () => {
      stop();
      subscription?.remove();
    };
  }, []);

  const saveWorkspace = useCallback(async () => {
    const nextWorkspace = workspaceDraft.trim();
    if (!nextWorkspace || savingWorkspace) {
      return;
    }

    try {
      setSavingWorkspace(true);
      const updated = await api.setChatWorkspace(activeChat.id, nextWorkspace);
      setActiveChat(updated);
      setWorkspaceDraft(updated.cwd ?? nextWorkspace);
      setError(null);
      onChatUpdated?.(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingWorkspace(false);
    }
  }, [activeChat.id, api, onChatUpdated, savingWorkspace, workspaceDraft]);

  const commit = useCallback(async () => {
    const trimmedMessage = commitMessage.trim();
    if (!trimmedMessage) {
      return;
    }

    try {
      setCommitting(true);
      const result = await api.gitCommit({
        message: trimmedMessage,
        cwd: requestedCwd,
      });
      if (!result.committed) {
        setError(result.stderr || 'Commit failed.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [api, commitMessage, refresh, requestedCwd]);

  const push = useCallback(async () => {
    try {
      setPushing(true);
      const result = await api.gitPush(requestedCwd);
      if (!result.pushed) {
        setError(result.stderr || 'Push failed.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPushing(false);
    }
  }, [api, refresh, requestedCwd]);

  const openBranchPanel = useCallback(() => {
    setBranchPanelOpen((current) => {
      const nextOpen = !current;
      if (nextOpen) {
        setBranchDraft(status?.branch ?? '');
        void api
          .gitBranches(requestedCwd)
          .then((result) => {
            setBranches(result.branches);
            setBranchDraft(result.current ?? status?.branch ?? '');
          })
          .catch((err) => {
            setError((err as Error).message);
          });
      }
      return nextOpen;
    });
  }, [api, requestedCwd, status?.branch]);

  const switchBranch = useCallback(
    async (nextBranch?: string) => {
      const branch = (nextBranch ?? branchDraft).trim();
      if (!branch || switchingBranch) {
        return;
      }

      try {
        setSwitchingBranch(true);
        const result = await api.gitSwitch({
          branch,
          cwd: requestedCwd,
        });
        if (!result.switched) {
          setError(result.stderr || result.stdout || `Failed to switch to ${branch}.`);
        } else {
          setBranchPanelOpen(false);
          setBranchDraft(branch);
          setError(null);
          await refresh();
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSwitchingBranch(false);
      }
    },
    [api, branchDraft, refresh, requestedCwd, switchingBranch],
  );

  const stageFile = useCallback(
    async (path: string) => {
      if (!path.trim()) {
        return;
      }

      try {
        setStagingPath(path);
        const result = await api.gitStage({
          path,
          cwd: requestedCwd,
        });
        if (!result.staged) {
          setError(result.stderr || `Failed to stage ${path}.`);
        } else {
          setError(null);
        }
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setStagingPath((current) => (current === path ? null : current));
      }
    },
    [api, refresh, requestedCwd],
  );

  const unstageFile = useCallback(
    async (path: string) => {
      if (!path.trim()) {
        return;
      }

      try {
        setUnstagingPath(path);
        const result = await api.gitUnstage({
          path,
          cwd: requestedCwd,
        });
        if (!result.unstaged) {
          setError(result.stderr || `Failed to unstage ${path}.`);
        } else {
          setError(null);
        }
        await refresh();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setUnstagingPath((current) => (current === path ? null : current));
      }
    },
    [api, refresh, requestedCwd],
  );

  const stageAll = useCallback(async () => {
    try {
      setStagingAll(true);
      const result = await api.gitStageAll(requestedCwd);
      if (!result.staged) {
        setError(result.stderr || 'Failed to stage all files.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStagingAll(false);
    }
  }, [api, refresh, requestedCwd]);

  const unstageAll = useCallback(async () => {
    try {
      setUnstagingAll(true);
      const result = await api.gitUnstageAll(requestedCwd);
      if (!result.unstaged) {
        setError(result.stderr || 'Failed to unstage all files.');
      } else {
        setError(null);
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUnstagingAll(false);
    }
  }, [api, refresh, requestedCwd]);

  const workspaceChanged = workspaceDraft.trim() !== workspaceCwd;
  const commitWorkspaceIfChanged = useCallback(() => {
    if (!workspaceChanged || !workspaceDraft.trim() || savingWorkspace) {
      return;
    }

    void saveWorkspace();
  }, [saveWorkspace, savingWorkspace, workspaceChanged, workspaceDraft]);

  const derived = useGitScreenDerived({
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
  });

  const reviewController = useGitScreenReviewController({
    api,
    approvalMode,
    activeChat,
    requestedCwd,
    derived,
    onBack,
    onChatUpdated,
    setActiveChat,
    setError,
  });

  const disableBodyScroll = useCallback(() => {
    setBodyScrollEnabled((previous) => (previous ? false : previous));
  }, []);

  const enableBodyScroll = useCallback(() => {
    setBodyScrollEnabled((previous) => (previous ? previous : true));
  }, []);

  useEffect(() => {
    if ((loading || !derived.hasChanges) && !bodyScrollEnabled) {
      setBodyScrollEnabled(true);
    }
  }, [bodyScrollEnabled, derived.hasChanges, loading]);

  useEffect(() => {
    if (stagingPath && !derived.changedFiles.some((entry) => entry.stagePath === stagingPath)) {
      setStagingPath(null);
    }
    if (unstagingPath && !derived.changedFiles.some((entry) => entry.stagePath === unstagingPath)) {
      setUnstagingPath(null);
    }
  }, [derived.changedFiles, stagingPath, unstagingPath]);

  return {
    activeChat,
    status,
    history,
    branchDraft,
    branchPanelOpen,
    commitMessage,
    workspaceDraft,
    loading,
    refreshing,
    savingWorkspace,
    committing,
    pushing,
    switchingBranch,
    stagingPath,
    unstagingPath,
    stagingAll,
    unstagingAll,
    bodyScrollEnabled,
    error,
    requestedCwd,
    derived,
    setBranchDraft,
    setWorkspaceDraft,
    setCommitMessage,
    refresh,
    commitWorkspaceIfChanged,
    openBranchPanel,
    switchBranch,
    commit,
    push,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    disableBodyScroll,
    enableBodyScroll,
    ...reviewController,
  };
}

export type GitScreenController = ReturnType<typeof useGitScreenController>;
