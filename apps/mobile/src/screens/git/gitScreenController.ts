import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWindowDimensions } from 'react-native';

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
  const requestedCwd = useMemo(() => {
    const draft = workspaceDraft.trim();
    if (draft.length > 0) {
      return draft;
    }
    return workspaceCwd.length > 0 ? workspaceCwd : undefined;
  }, [workspaceCwd, workspaceDraft]);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const [nextStatus, nextDiff, nextHistory, nextBranches] = await Promise.all([
        api.gitStatus(requestedCwd),
        api.gitDiff(requestedCwd),
        api.gitHistory(requestedCwd, 12),
        api.gitBranches(requestedCwd).catch(() => null),
      ]);
      setStatus(nextStatus);
      setDiff(nextDiff);
      setHistory(nextHistory.commits);
      setBranches(nextBranches?.branches ?? []);
      setBranchDraft(nextBranches?.current ?? nextStatus.branch ?? '');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [api, requestedCwd]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

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
