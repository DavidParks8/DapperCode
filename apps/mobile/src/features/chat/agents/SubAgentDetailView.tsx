import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlatList } from 'react-native';
import { Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Chat, RpcNotification } from '@bridge/types/types';
import { showToolCallsAtom } from '@shell/state/appState/settings';
import { bridgeConnectedAtom, bridgeTokenAtom, bridgeUrlAtom } from '@shell/state/bridge/atoms';
import { useBridgeApi, useBridgeWs } from '@shell/state/bridge/hooks';
import { liveAssistantByThreadAtom } from '../state/turn';
import { runWatchdogNowAtom } from '../state/session';
import { threadRuntimeSnapshotsAtom } from '../state/runtime';
import {
  agentRootThreadIdAtom,
  agentRuntimeRevisionAtom,
  relatedAgentThreadsAtom,
} from '../../workspace/state/workspace';
import { openBrowserAtom, openSubAgentAtom } from '@shell/navigation/actions';
import type { AutoScrollState } from '../helpers/helpers';
import { formatAgentThreadOptionTitle } from '../helpers/plansAndCommands';
import { indexAgentThreadOrdinals } from './threads';
import { AgentThreadsController } from './controllers/threadsController';
import { buildAgentThreadDisplayState } from './threadDisplay';
import type { TranscriptDisplayItem } from '../transcript/messages';
import { useAppTheme } from '@shared/theme';
import { useAccessibilityFocus, useAccessibilityAnnouncement } from '@shared/accessibility';
import {
  resolveHydratedDetailState,
  resolveHydrationErrorState,
  resolveRefreshModeForEvent,
  resolveRememberedDetailState,
  resolveSubAgentSummary,
  mergeSummaryIntoChat,
  resolveAgentThreadStatusById,
  countProjectedMessages,
  resolveTranscriptState,
  navigateBackFromSubAgent,
  type SubAgentDetailState,
} from './detailViewState';
import {
  createStyles,
  SubAgentHeader,
  SubAgentStatusBar,
  SubAgentTranscriptContent,
} from './SubAgentDetailViewSections';
import { ChatAnimationClockProvider } from '../animation/ChatAnimationClock';

interface SubAgentDetailViewProps {
  threadId: string;
}

const SHIMMER_DELAY_MS = 120;
const SHIMMER_MIN_VISIBLE_MS = 350;
const SHIMMER_REVEAL_HOLD_MS = 34;

function useShimmerPresentation(active: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const visibleSinceRef = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      if (visible) {
        return;
      }
      const timer = setTimeout(() => {
        visibleSinceRef.current = Date.now();
        setVisible(true);
      }, SHIMMER_DELAY_MS);
      return () => clearTimeout(timer);
    }

    if (!visible) {
      visibleSinceRef.current = null;
      return;
    }

    const elapsed = Date.now() - (visibleSinceRef.current ?? Date.now());
    const timer = setTimeout(
      () => {
        visibleSinceRef.current = null;
        setVisible(false);
      },
      Math.max(SHIMMER_REVEAL_HOLD_MS, SHIMMER_MIN_VISIBLE_MS - elapsed),
    );
    return () => clearTimeout(timer);
  }, [active, visible]);

  return visible;
}

export function SubAgentDetailView({ threadId }: SubAgentDetailViewProps) {
  const router = useRouter();
  const { chatId, profileId } = useLocalSearchParams<{
    chatId?: string;
    profileId?: string;
  }>();
  const api = useBridgeApi();
  const ws = useBridgeWs();
  const bridgeUrl = useAtomValue(bridgeUrlAtom) ?? '';
  const bridgeToken = useAtomValue(bridgeTokenAtom);
  const bridgeConnected = useAtomValue(bridgeConnectedAtom);
  const showToolCalls = useAtomValue(showToolCallsAtom);
  const liveAssistantByThread = useAtomValue(liveAssistantByThreadAtom);
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const agentRootThreadId = useAtomValue(agentRootThreadIdAtom);
  const agentRuntimeRevision = useAtomValue(agentRuntimeRevisionAtom);
  const runWatchdogNow = useAtomValue(runWatchdogNowAtom);
  const threadRuntimeSnapshots = useAtomValue(threadRuntimeSnapshotsAtom);
  const openBrowserFromChat = useSetAtom(openBrowserAtom);
  const openBrowser = useCallback(
    (targetUrl: string) => openBrowserFromChat(targetUrl, threadId),
    [openBrowserFromChat, threadId],
  );
  const openSubAgent = useSetAtom(openSubAgentAtom);
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const controller = useMemo(() => new AgentThreadsController(api), [api]);
  const requestRef = useRef(0);
  const detailChatRef = useRef<Chat | null>(null);
  const hydrationFailedRef = useRef(false);
  const foregroundHydrationRef = useRef(false);
  const [detail, setDetail] = useState<SubAgentDetailState>(() => ({
    chat: api.peekChat(threadId) ?? api.peekChatShell(threadId),
    parentChat: null,
    loading: true,
    error: null,
  }));
  const scrollRef = useRef<FlatList<TranscriptDisplayItem>>(null);
  const autoScrollStateRef = useRef<AutoScrollState>({
    shouldStickToBottom: true,
    isUserInteracting: false,
    isMomentumScrolling: false,
  });
  detailChatRef.current = detail.chat;
  const hydrate = useCallback(
    async (showLoading: boolean) => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      if (showLoading) {
        foregroundHydrationRef.current = true;
        setDetail((current) => (current.loading ? current : { ...current, loading: true }));
      }

      try {
        const { chat, parent } = await controller.loadDetail(threadId);
        if (requestRef.current !== requestId) {
          return;
        }
        hydrationFailedRef.current = false;
        setDetail((current) => resolveHydratedDetailState(current, chat, parent));
      } catch (error) {
        if (requestRef.current !== requestId) {
          return;
        }
        hydrationFailedRef.current = true;
        setDetail((current) => resolveHydrationErrorState(current, showLoading, error));
      } finally {
        if (showLoading && requestRef.current === requestId) {
          foregroundHydrationRef.current = false;
        }
      }
    },
    [controller, threadId],
  );

  useEffect(() => {
    requestRef.current += 1;
    hydrationFailedRef.current = false;
    void hydrate(true);
    return () => {
      requestRef.current += 1;
    };
  }, [api, hydrate, threadId]);

  useEffect(
    () =>
      ws.onEvent((event: RpcNotification) => {
        const showLoading = resolveRefreshModeForEvent({
          event,
          threadId,
          detailChat: detailChatRef.current,
          hydrationFailed: hydrationFailedRef.current,
          foregroundHydration: foregroundHydrationRef.current,
        });
        if (showLoading !== null) {
          void hydrate(showLoading);
        }
      }),
    [hydrate, threadId, ws],
  );

  useEffect(() => {
    const remembered = api.peekChat(threadId);
    if (!remembered) {
      return;
    }
    setDetail((current) => resolveRememberedDetailState(current, remembered));
  }, [agentRuntimeRevision, api, threadId]);

  const summary = useMemo(
    () =>
      resolveSubAgentSummary({
        relatedAgentThreads,
        api,
        threadId,
        detailChat: detail.chat,
        revision: agentRuntimeRevision,
      }),
    [agentRuntimeRevision, api, detail.chat, relatedAgentThreads, threadId],
  );
  const chat = useMemo(() => mergeSummaryIntoChat(detail.chat, summary), [detail.chat, summary]);
  const statusMapRef = useRef<ReadonlyMap<string, Chat['status']>>(new Map());
  const agentThreadStatusById = useMemo(() => {
    const statuses = resolveAgentThreadStatusById(statusMapRef.current, relatedAgentThreads, chat);
    statusMapRef.current = statuses;
    return statuses;
  }, [chat, relatedAgentThreads]);
  const agentThreadOrdinals = useMemo(
    () => indexAgentThreadOrdinals(relatedAgentThreads, agentRootThreadId),
    [agentRootThreadId, relatedAgentThreads],
  );
  const ordinal = agentThreadOrdinals.get(threadId) ?? null;
  const runtime = threadRuntimeSnapshots[threadId] ?? null;
  const display = summary ? buildAgentThreadDisplayState(summary, runtime, runWatchdogNow) : null;
  const title = summary
    ? formatAgentThreadOptionTitle(summary, agentRootThreadId, ordinal)
    : 'Sub-agent';
  const liveMessageState = liveAssistantByThread[threadId] ?? null;

  // A sub-agent that has just been spawned has no transcript yet. Rendering an
  // empty scroll view makes a live agent look dead, so it gets an explicit
  // starting state until its first message arrives.
  const projectedMessageCount = useMemo(
    () =>
      countProjectedMessages({
        chat,
        parentChat: detail.parentChat,
        showToolCalls,
        threadStatuses: agentThreadStatusById,
        liveMessageState,
      }),
    [agentThreadStatusById, chat, detail.parentChat, liveMessageState, showToolCalls],
  );

  // A non-empty summary preview is evidence that an empty shell still has history to hydrate.
  // Without that evidence, a running summary is a genuinely new agent and should go directly to
  // "Starting" rather than briefly promising transcript rows that do not exist.
  const { activityDetail, isStarting, isEmpty, isHydratingTranscript } = useMemo(
    () =>
      resolveTranscriptState({
        summary,
        chat,
        loading: detail.loading,
        projectedMessageCount,
        display,
        runtime,
      }),
    [chat, detail.loading, display, projectedMessageCount, runtime, summary],
  );
  const showHydrationShimmer = useShimmerPresentation(isHydratingTranscript);
  const headingFocusRef = useAccessibilityFocus<Text>(true);
  useAccessibilityAnnouncement(
    detail.error ?? (isHydratingTranscript ? 'Loading agent transcript' : null),
  );

  const navigateBack = useCallback(
    () => navigateBackFromSubAgent(router, profileId, chatId),
    [chatId, profileId, router],
  );

  const openSubAgentThread = useCallback(
    (nextThreadId: string) => openSubAgent(nextThreadId),
    [openSubAgent],
  );

  return (
    <ChatAnimationClockProvider enabled={bridgeConnected}>
      <SafeAreaView style={styles.page}>
        <SubAgentHeader
          title={title}
          navigateBack={navigateBack}
          headingFocusRef={headingFocusRef}
          styles={styles}
          theme={theme}
        />
        <SubAgentStatusBar
          display={display}
          loading={detail.loading}
          activityDetail={activityDetail}
          styles={styles}
          theme={theme}
        />

        {detail.error ? (
          <Text
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={styles.errorText}
          >
            {detail.error}
          </Text>
        ) : null}
        <SubAgentTranscriptContent
          chat={chat}
          parentChat={detail.parentChat}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
          openBrowser={openBrowser}
          showToolCalls={showToolCalls}
          onOpenSubAgentThread={openSubAgentThread}
          agentThreadStatusById={agentThreadStatusById}
          scrollRef={scrollRef}
          autoScrollStateRef={autoScrollStateRef}
          liveMessageState={liveMessageState}
          projectedMessageCount={projectedMessageCount}
          isStarting={isStarting}
          isEmpty={isEmpty}
          isHydratingTranscript={isHydratingTranscript}
          showHydrationShimmer={showHydrationShimmer}
          detailLoading={detail.loading}
          styles={styles}
          theme={theme}
        />
      </SafeAreaView>
    </ChatAnimationClockProvider>
  );
}
