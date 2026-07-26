import { useAtomValue } from 'jotai';
import { useCallback, useMemo, useRef, useState } from 'react';
import { creatingAtom, sendingAtom, stoppingTurnAtom } from '../state/mainScreen/turn';
import { type FlatList, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AgentId, RunEvent, Chat, FileSystemListResponse } from '../api/types';
import type { TranscriptDisplayItem } from './transcriptMessages';
import { useAppTheme } from '../theme';
import { createStyles } from './mainScreenStyles';
import { type IdleTaskHandle } from './mainScreenHelpers';
import { ApprovalController } from './controllers/approvalController';
import { AgentThreadsController } from './controllers/agentThreadsController';
import { ChatSyncController } from './controllers/chatSyncController';
import { useDraftController } from './controllers/draftController';
import { SubmissionController } from './controllers/submissionController';
import { TurnExecutionController } from './controllers/turnExecutionController';
import { MainScreenPersistenceController } from './controllers/mainScreenPersistenceController';
import { TranscriptContinuationController, getTranscriptContinuationState, type TranscriptContinuationState } from './controllers/transcriptContinuationController';
import type { MainScreenBaseContext } from './useMainScreenBaseContext';






export type MainScreenCoreBootstrapContext = MainScreenBaseContext;

export function useMainScreenCoreBootstrap(context: MainScreenCoreBootstrapContext) {
  const {
    agentSettings,
    api,
    bridgeProfileId,
    pendingOpenChatId,
    pendingOpenChatSnapshot,
    preferredAgentId,
  } = context;

  const theme = useAppTheme();
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const chatSyncController = useMemo(() => new ChatSyncController(api), [api]);
  const turnExecutionController = useMemo(() => new TurnExecutionController(api), [api]);
  const approvalController = useMemo(() => new ApprovalController(api), [api]);
  const agentThreadsController = useMemo(() => new AgentThreadsController(api), [api]);
  const persistenceController = useMemo(() => new MainScreenPersistenceController(), []);
  const submissionController = useMemo(() => new SubmissionController(), []);
  const transcriptContinuationController = useMemo(
    () => new TranscriptContinuationController(api),
    [api]
  );
  const initialPendingSnapshot =
    pendingOpenChatId &&
    pendingOpenChatSnapshot?.id === pendingOpenChatId &&
    pendingOpenChatSnapshot.messages.length > 0
      ? pendingOpenChatSnapshot
      : null;
  const [selectedChat, setSelectedChat] = useState<Chat | null>(
    initialPendingSnapshot
  );
  const [transcriptContinuationState, setTranscriptContinuationState] =
    useState<TranscriptContinuationState>(() =>
      initialPendingSnapshot
        ? getTranscriptContinuationState(initialPendingSnapshot)
        : { loading: false, error: null, exhausted: true, unavailableCount: 0 }
    );
  const [selectedParentChat, setSelectedParentChat] = useState<Chat | null>(null);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(
    initialPendingSnapshot?.id ?? pendingOpenChatId ?? null
  );
  const [openingChatId, setOpeningChatId] = useState<string | null>(
    initialPendingSnapshot ? null : pendingOpenChatId ?? null
  );
  const openingChatStartedAtRef = useRef<number>(
    initialPendingSnapshot || !pendingOpenChatId ? 0 : Date.now()
  );
  const draftController = useDraftController(bridgeProfileId, selectedChatId);
  const { draft, setDraft } = draftController;
  const [, setActiveCommands] = useState<RunEvent[]>([]);
  const streamingTextRef = useRef<string | null>(null);
  const setStreamingText = useCallback(
    (
      next:
        | string
        | null
        | ((previous: string | null) => string | null)
    ) => {
      const resolved =
        typeof next === 'function'
          ? (
              next as (previous: string | null) => string | null
            )(streamingTextRef.current)
          : next;
      streamingTextRef.current = resolved;
    },
    []
  );
  const [, setLoadingWorkspaceRoots] = useState(false);
  const workspaceBrowseCacheRef = useRef<Record<string, FileSystemListResponse>>({});
  const workspaceBrowseRequestRef = useRef(0);
  const [pendingAgentId, setPendingAgentId] = useState<AgentId | null>(
    () => preferredAgentId ?? Object.keys(agentSettings ?? {})[0] ?? null
  );
  const sending = useAtomValue(sendingAtom);
  const creating = useAtomValue(creatingAtom);
  const stoppingTurn = useAtomValue(stoppingTurnAtom);
  const sendingRef = useRef(sending);
  sendingRef.current = sending;
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  const stoppingTurnRef = useRef(stoppingTurn);
  stoppingTurnRef.current = stoppingTurn;
  const heldActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genericRunningActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const foregroundAgentRefreshHandleRef = useRef<IdleTaskHandle | null>(null);
  const safeAreaInsets = useSafeAreaInsets();
  const scrollRef = useRef<FlatList<TranscriptDisplayItem>>(null);
  const scrollRetryTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const scheduledPinnedScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPinnedScrollAtRef = useRef(0);

  return {
    theme,
    windowHeight,
    styles,
    chatSyncController,
    turnExecutionController,
    approvalController,
    agentThreadsController,
    persistenceController,
    submissionController,
    transcriptContinuationController,
    initialPendingSnapshot,
    selectedChat,
    setSelectedChat,
    transcriptContinuationState,
    setTranscriptContinuationState,
    selectedParentChat,
    setSelectedParentChat,
    selectedChatId,
    setSelectedChatId,
    openingChatId,
    setOpeningChatId,
    openingChatStartedAtRef,
    draftController,
    draft,
    setDraft,
    setActiveCommands,
    streamingTextRef,
    setStreamingText,
    setLoadingWorkspaceRoots,
    workspaceBrowseCacheRef,
    workspaceBrowseRequestRef,
    pendingAgentId,
    setPendingAgentId,
    sendingRef,
    creatingRef,
    stoppingTurnRef,
    heldActivityTimeoutRef,
    genericRunningActivityTimeoutRef,
    foregroundAgentRefreshHandleRef,
    safeAreaInsets,
    scrollRef,
    scrollRetryTimeoutsRef,
    scheduledPinnedScrollTimeoutRef,
    lastPinnedScrollAtRef,
  };
}

export type MainScreenCoreBootstrapResult = ReturnType<typeof useMainScreenCoreBootstrap>;
