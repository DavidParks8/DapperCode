import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { HostBridgeApiClient } from '../../api/client';
import type { ApprovalMode, Chat } from '../../api/types';
import { toApprovalPolicyForMode } from '../main/mainScreenHelpers';
import {
  buildGitReviewPrompt,
  createGitReviewTarget,
  type GitReviewComment,
  type GitReviewTarget,
} from './gitDiffReview';
import type { UnifiedDiffFile, UnifiedDiffLine } from './gitDiff';
import type { GitScreenDerivedState } from './gitScreenTypes';

interface UseGitScreenReviewControllerArgs {
  api: HostBridgeApiClient;
  approvalMode: ApprovalMode | undefined;
  activeChat: Chat;
  requestedCwd: string | undefined;
  derived: GitScreenDerivedState;
  onBack: () => void;
  onChatUpdated?: (chat: Chat) => void;
  setActiveChat: (nextChat: Chat) => void;
  setError: (message: string | null) => void;
}

export function useGitScreenReviewController({
  api,
  approvalMode,
  activeChat,
  requestedCwd,
  derived,
  onBack,
  onChatUpdated,
  setActiveChat,
  setError,
}: UseGitScreenReviewControllerArgs) {
  const [selectedDiffFileId, setSelectedDiffFileId] = useState<string | null>(null);
  const [pendingDiffFileId, setPendingDiffFileId] = useState<string | null>(null);
  const [switchingDiffFile, setSwitchingDiffFile] = useState(false);
  const [reviewComments, setReviewComments] = useState<GitReviewComment[]>([]);
  const [reviewTarget, setReviewTarget] = useState<GitReviewTarget | null>(null);
  const [reviewCommentDraft, setReviewCommentDraft] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);

  const diffSelectionRequestRef = useRef(0);
  const diffSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reviewCommentIdRef = useRef(0);

  const selectedDiffFile = useMemo(() => {
    if (derived.parsedDiff.files.length === 0) {
      return null;
    }

    return (
      derived.parsedDiff.files.find((file: UnifiedDiffFile) => file.id === selectedDiffFileId) ??
      derived.parsedDiff.files[0]
    );
  }, [derived.parsedDiff.files, selectedDiffFileId]);

  const diffFileForView = useMemo(() => {
    if (derived.parsedDiff.files.length === 0) {
      return null;
    }

    const targetId = pendingDiffFileId ?? selectedDiffFile?.id ?? derived.parsedDiff.files[0].id;
    return (
      derived.parsedDiff.files.find((file: UnifiedDiffFile) => file.id === targetId) ??
      derived.parsedDiff.files[0]
    );
  }, [derived.parsedDiff.files, pendingDiffFileId, selectedDiffFile]);

  const activeDiffTabId = pendingDiffFileId ?? diffFileForView?.id ?? null;
  const showDiffFileSwitching = switchingDiffFile && Boolean(pendingDiffFileId);

  const validReviewAnchorKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const file of derived.parsedDiff.files) {
      for (const hunk of file.hunks) {
        hunk.lines.forEach((line: UnifiedDiffLine, lineIndex: number) => {
          const target = createGitReviewTarget(file, hunk, line, lineIndex);
          if (target) {
            keys.add(target.anchorKey);
          }
        });
      }
    }
    return keys;
  }, [derived.parsedDiff.files]);

  useEffect(() => {
    if (derived.parsedDiff.files.length === 0) {
      if (selectedDiffFileId) {
        setSelectedDiffFileId(null);
      }
      if (pendingDiffFileId) {
        setPendingDiffFileId(null);
      }
      if (switchingDiffFile) {
        setSwitchingDiffFile(false);
      }
      return;
    }

    if (!selectedDiffFileId) {
      setSelectedDiffFileId(derived.parsedDiff.files[0].id);
      return;
    }

    const stillExists = derived.parsedDiff.files.some(
      (file: UnifiedDiffFile) => file.id === selectedDiffFileId,
    );
    if (!stillExists) {
      setSelectedDiffFileId(derived.parsedDiff.files[0].id);
    }

    if (pendingDiffFileId) {
      const pendingStillExists = derived.parsedDiff.files.some(
        (file: UnifiedDiffFile) => file.id === pendingDiffFileId,
      );
      if (!pendingStillExists) {
        setPendingDiffFileId(null);
        setSwitchingDiffFile(false);
      }
    }
  }, [derived.parsedDiff.files, pendingDiffFileId, selectedDiffFileId, switchingDiffFile]);

  useEffect(() => {
    setReviewComments((current) => {
      const next = current.filter((comment) => validReviewAnchorKeys.has(comment.anchorKey));
      return next.length === current.length ? current : next;
    });
  }, [validReviewAnchorKeys]);

  const selectDiffFile = useCallback(
    (fileId: string) => {
      if (!fileId || fileId === activeDiffTabId) {
        return;
      }

      diffSelectionRequestRef.current += 1;
      const requestId = diffSelectionRequestRef.current;
      setPendingDiffFileId(fileId);
      setSwitchingDiffFile(true);
      if (diffSelectionTimerRef.current) {
        clearTimeout(diffSelectionTimerRef.current);
      }
      diffSelectionTimerRef.current = setTimeout(() => {
        if (diffSelectionRequestRef.current !== requestId) {
          return;
        }

        setSelectedDiffFileId(fileId);
        setSwitchingDiffFile(false);
        setPendingDiffFileId(null);
        diffSelectionTimerRef.current = null;
      }, 120);
    },
    [activeDiffTabId],
  );

  const openReviewComment = useCallback(
    (target: GitReviewTarget) => {
      const existing = reviewComments.find((comment) => comment.anchorKey === target.anchorKey);
      setReviewTarget(target);
      setReviewCommentDraft(existing?.comment ?? '');
    },
    [reviewComments],
  );

  const closeReviewComment = useCallback(() => {
    setReviewTarget(null);
    setReviewCommentDraft('');
  }, []);

  const saveReviewComment = useCallback(() => {
    if (!reviewTarget) {
      return;
    }
    const comment = reviewCommentDraft.trim();
    if (!comment) {
      return;
    }

    setReviewComments((current) => {
      const existing = current.find((entry) => entry.anchorKey === reviewTarget.anchorKey);
      if (!existing) {
        reviewCommentIdRef.current += 1;
      }
      const next: GitReviewComment = {
        ...reviewTarget,
        id: existing?.id ?? `C${String(reviewCommentIdRef.current)}`,
        comment,
      };
      return existing
        ? current.map((entry) => (entry.anchorKey === reviewTarget.anchorKey ? next : entry))
        : [...current, next];
    });
    closeReviewComment();
  }, [closeReviewComment, reviewCommentDraft, reviewTarget]);

  const deleteReviewComment = useCallback((anchorKey: string) => {
    setReviewComments((current) => current.filter((comment) => comment.anchorKey !== anchorKey));
  }, []);

  const submitReview = useCallback(async () => {
    if (reviewComments.length === 0 || submittingReview) {
      return;
    }

    try {
      setSubmittingReview(true);
      const result = await api.sendOrQueueChatMessage(activeChat.id, {
        content: buildGitReviewPrompt(reviewComments, requestedCwd),
        cwd: requestedCwd,
        approvalPolicy: toApprovalPolicyForMode(approvalMode),
      });
      if (result.chat) {
        setActiveChat(result.chat);
        onChatUpdated?.(result.chat);
      }
      setReviewComments([]);
      setError(null);
      onBack();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmittingReview(false);
    }
  }, [
    activeChat.id,
    api,
    approvalMode,
    onBack,
    onChatUpdated,
    requestedCwd,
    reviewComments,
    setActiveChat,
    setError,
    submittingReview,
  ]);

  useEffect(() => {
    return () => {
      if (diffSelectionTimerRef.current) {
        clearTimeout(diffSelectionTimerRef.current);
      }
    };
  }, []);

  return {
    reviewComments,
    reviewTarget,
    reviewCommentDraft,
    submittingReview,
    selectedDiffFile,
    diffFileForView,
    activeDiffTabId,
    showDiffFileSwitching,
    setReviewComments,
    setReviewCommentDraft,
    selectDiffFile,
    openReviewComment,
    closeReviewComment,
    saveReviewComment,
    deleteReviewComment,
    submitReview,
  };
}
