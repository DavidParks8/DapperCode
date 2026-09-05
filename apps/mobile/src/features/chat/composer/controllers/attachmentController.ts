import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Keyboard } from 'react-native';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat, LocalImageInput, MentionInput } from '@bridge/types/types';
import {
  type AttachmentMenuAction,
  type ComposerAttachmentChip,
  draftContainsMentionLabel,
  normalizeAttachmentPath,
  scheduleIdleTask,
  toMentionInput,
  toPathBasename,
} from '../../helpers/helpers';
import { type PastedImage, useAttachmentUploadController } from './attachmentUploadController';

export {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_LABEL,
  attachmentSizeError,
  retainFailedPreparedAttachment,
} from './attachmentUploadController';
export type { PastedImage, PreparedAttachment } from './attachmentUploadController';

type AttachmentApi = Pick<HostBridgeApiClient, 'uploadAttachment'>;

export function addUniqueAttachmentPath(paths: string[], rawPath: string): string[] | null {
  const normalized = normalizeAttachmentPath(rawPath);
  if (!normalized) {
    return null;
  }
  return paths.some((path) => path.toLowerCase() === normalized.toLowerCase())
    ? paths
    : [...paths, normalized];
}

export interface AttachmentController {
  attachmentModalVisible: boolean;
  attachmentMenuVisible: boolean;
  attachmentPathDraft: string;
  setAttachmentPathDraft: React.Dispatch<React.SetStateAction<string>>;
  pendingMentionPaths: string[];
  pendingLocalImagePaths: string[];
  pickerBusy: boolean;
  pasteBusy: boolean;
  pasteImage: (image: PastedImage) => Promise<void>;
  setPasteBusy: (event: { busy: boolean; scopeKey: string }) => void;
  pasteError: (event: { message: string; scopeKey: string }) => void;
  uploading: boolean;
  hasFailedUploads: boolean;
  composerAttachments: ComposerAttachmentChip[];
  openMenu: () => void;
  closeMenu: () => void;
  requestMenuAction: (action: Exclude<AttachmentMenuAction, null>) => void;
  closePathModal: () => void;
  submitPath: () => void;
  removeComposerAttachment: (id: string) => void;
  removeMentionPath: (path: string) => void;
  retryFailedUploads: () => void;
  clearPending: () => void;
  beginSubmission: () => void;
  finishSubmission: (succeeded: boolean, restoringDraft?: boolean) => void;
  clear: () => void;
  toTurnInputs: (cwd?: string | null) => {
    mentions: MentionInput[];
    localImages: LocalImageInput[];
  };
}
export function useAttachmentController({
  api,
  chat,
  scopeKey = chat?.id ?? 'new',
  draft,
  setError,
}: {
  api: AttachmentApi;
  chat: Chat | null;
  scopeKey?: string;
  draft: string;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}): AttachmentController {
  const [attachmentModalVisible, setAttachmentModalVisible] = useState(false);
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
  const [attachmentPathDraft, setAttachmentPathDraft] = useState('');
  const [pendingAction, setPendingAction] = useState<AttachmentMenuAction>(null);
  const [pendingMentionPaths, setPendingMentionPaths] = useState<string[]>([]);
  const [pendingLocalImagePaths, setPendingLocalImagePaths] = useState<string[]>([]);
  const submissionPendingRef = useRef(false);
  const skipNextDraftReconcileRef = useRef(false);

  const addMention = useCallback(
    (rawPath: string) => {
      const normalized = normalizeAttachmentPath(rawPath);
      if (!normalized) {
        setError('Enter a file path to attach');
        return false;
      }
      setPendingMentionPaths((current) => addUniqueAttachmentPath(current, normalized) ?? current);
      setError(null);
      return true;
    },
    [setError],
  );

  const addImage = useCallback(
    (rawPath: string) => {
      const normalized = normalizeAttachmentPath(rawPath);
      if (!normalized) {
        setError('Image path is invalid');
        return false;
      }
      setPendingLocalImagePaths(
        (current) => addUniqueAttachmentPath(current, normalized) ?? current,
      );
      setError(null);
      return true;
    },
    [setError],
  );

  const {
    captureImage,
    clearUploads,
    pasteImage,
    pasteBusy,
    setPasteBusy,
    pasteError,
    pickerBusy,
    pickerInProgressRef,
    pickFile,
    pickImage,
    preparedAttachments,
    retryFailedUploads,
    removePreparedAttachment,
    uploading,
  } = useAttachmentUploadController({ api, chat, scopeKey, addImage, addMention, setError });

  const openPathModal = useCallback(() => {
    if (pickerInProgressRef.current) {
      return;
    }
    setAttachmentPathDraft('');
    setAttachmentModalVisible(true);
    setError(null);
  }, [pickerInProgressRef, setError]);

  useEffect(() => {
    if (submissionPendingRef.current) {
      return;
    }
    if (skipNextDraftReconcileRef.current) {
      skipNextDraftReconcileRef.current = false;
      return;
    }
    setPendingMentionPaths((current) => {
      const next = current.filter((path) => draftContainsMentionLabel(draft, toPathBasename(path)));
      return next.length === current.length ? current : next;
    });
  }, [draft]);

  useEffect(() => {
    if (attachmentMenuVisible || pendingAction === null) {
      return;
    }
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const idle = scheduleIdleTask(() => {
      timeout = setTimeout(() => {
        if (cancelled) {
          return;
        }
        const action = pendingAction;
        setPendingAction(null);
        if (action === 'workspace-path') {
          openPathModal();
        } else if (action === 'phone-file') {
          void pickFile();
        } else if (action === 'phone-image') {
          void pickImage();
        } else if (action === 'phone-camera') {
          void captureImage();
        }
      }, 180);
    });
    return () => {
      cancelled = true;
      idle.cancel();
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [attachmentMenuVisible, captureImage, openPathModal, pendingAction, pickFile, pickImage]);

  // Consumers keep this in dependency arrays of long-lived callbacks, so it must be stable.
  const closePathModal = useCallback(() => {
    setAttachmentModalVisible(false);
    setAttachmentPathDraft('');
  }, []);

  const clear = useCallback(() => {
    clearUploads();
    setPendingAction(null);
    submissionPendingRef.current = false;
    skipNextDraftReconcileRef.current = false;
    setAttachmentModalVisible(false);
    setAttachmentMenuVisible(false);
    setAttachmentPathDraft('');
    setPendingMentionPaths([]);
    setPendingLocalImagePaths([]);
  }, [clearUploads]);

  useLayoutEffect(() => {
    clear();
  }, [clear, scopeKey]);

  const composerAttachments = useMemo(
    () => [
      ...pendingLocalImagePaths.map((path) => ({
        id: `image:${path}`,
        label: `image · ${toPathBasename(path)}`,
      })),
      ...preparedAttachments.map((attachment) => ({
        id: `prepared:${attachment.id}`,
        label: `${attachment.status === 'failed' ? 'retry' : 'uploading'} · ${attachment.fileName ?? toPathBasename(attachment.uri)}`,
      })),
    ],
    [pendingLocalImagePaths, preparedAttachments],
  );

  return {
    attachmentModalVisible,
    attachmentMenuVisible,
    attachmentPathDraft,
    setAttachmentPathDraft,
    pendingMentionPaths,
    pendingLocalImagePaths,
    pickerBusy,
    pasteImage,
    pasteBusy,
    setPasteBusy,
    pasteError,
    uploading,
    hasFailedUploads: preparedAttachments.some((attachment) => attachment.status === 'failed'),
    composerAttachments,
    openMenu: () => {
      if (!pickerInProgressRef.current && !uploading) {
        Keyboard.dismiss();
        setAttachmentMenuVisible(true);
      }
    },
    closeMenu: () => setAttachmentMenuVisible(false),
    requestMenuAction: (action) => {
      setAttachmentMenuVisible(false);
      setPendingAction(action);
    },
    closePathModal,
    submitPath: () => {
      if (addMention(attachmentPathDraft)) {
        setAttachmentPathDraft('');
        setAttachmentModalVisible(false);
      }
    },
    removeComposerAttachment: (id) => {
      if (id.startsWith('prepared:')) {
        removePreparedAttachment(id.slice('prepared:'.length));
      } else if (id.startsWith('file:')) {
        setPendingMentionPaths((current) => current.filter((path) => path !== id.slice(5)));
      } else if (id.startsWith('image:')) {
        setPendingLocalImagePaths((current) => current.filter((path) => path !== id.slice(6)));
      }
    },
    removeMentionPath: (path) => {
      setPendingMentionPaths((current) => current.filter((entry) => entry !== path));
    },
    retryFailedUploads,
    clearPending: () => {
      clearUploads();
      setPendingMentionPaths([]);
      setPendingLocalImagePaths([]);
    },
    beginSubmission: () => {
      submissionPendingRef.current = true;
    },
    finishSubmission: (succeeded, restoringDraft = false) => {
      submissionPendingRef.current = false;
      skipNextDraftReconcileRef.current = restoringDraft;
      if (succeeded) {
        setPendingMentionPaths([]);
        setPendingLocalImagePaths([]);
      }
    },
    clear,
    toTurnInputs: (cwd) => ({
      mentions: pendingMentionPaths.map((path) => toMentionInput(path, cwd)),
      localImages: pendingLocalImagePaths.map((path) => ({ path })),
    }),
  };
}
