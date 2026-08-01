import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, type FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Chat, RpcNotification } from '../../api/types';
import { showToolCallsAtom } from '../../state/appState/settings';
import { bridgeTokenAtom, bridgeUrlAtom } from '../../state/bridge/atoms';
import { useBridgeApi, useBridgeWs } from '../../state/bridge/hooks';
import { liveAssistantByThreadAtom } from '../../state/mainScreen/turn';
import { runWatchdogNowAtom } from '../../state/mainScreen/session';
import { threadRuntimeSnapshotsAtom } from '../../state/mainScreen/runtime';
import {
  agentRootThreadIdAtom,
  agentRuntimeRevisionAtom,
  relatedAgentThreadsAtom,
} from '../../state/mainScreen/workspace';
import { openBrowserAtom, openSubAgentAtom } from '../../navigation/actions';
import { routes } from '../../navigation/routes';
import type { AutoScrollState } from './mainScreenHelpers';
import { extractNotificationThreadId } from './mainScreenHelpers';
import { formatAgentThreadOptionTitle } from './mainScreenHelperPlansAndCommands';
import { indexAgentThreadOrdinals } from './agentThreads';
import { AgentThreadsController } from './controllers/agentThreadsController';
import { buildAgentThreadDisplayState } from './agentThreadDisplay';
import { areChatStatusMapsEquivalent, resolveEquivalentChat } from './mainScreenChatState';
import { projectTranscript } from './controllers/transcriptProjectionController';
import type { TranscriptDisplayItem } from './transcriptMessages';
import { ChatTranscriptView } from './ChatTranscriptView';
import { useAppTheme, type AppTheme } from '../../theme';
import {
  decorativeAccessibilityProps,
  useAccessibilityFocus,
  useAccessibilityAnnouncement,
} from '../../accessibility';

interface SubAgentDetailViewProps {
  threadId: string;
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
  const showToolCalls = useAtomValue(showToolCallsAtom);
  const liveAssistantByThread = useAtomValue(liveAssistantByThreadAtom);
  const relatedAgentThreads = useAtomValue(relatedAgentThreadsAtom);
  const agentRootThreadId = useAtomValue(agentRootThreadIdAtom);
  const agentRuntimeRevision = useAtomValue(agentRuntimeRevisionAtom);
  const runWatchdogNow = useAtomValue(runWatchdogNowAtom);
  const threadRuntimeSnapshots = useAtomValue(threadRuntimeSnapshotsAtom);
  const openBrowser = useSetAtom(openBrowserAtom);
  const openSubAgent = useSetAtom(openSubAgentAtom);
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const controller = useMemo(() => new AgentThreadsController(api), [api]);
  const requestRef = useRef(0);
  const detailChatRef = useRef<Chat | null>(null);
  const hydrationFailedRef = useRef(false);
  const foregroundHydrationRef = useRef(false);
  const [detail, setDetail] = useState(() => ({
    chat: api.peekChat(threadId) ?? api.peekChatShell(threadId),
    parentChat: null as Chat | null,
    loading: true,
    error: null as string | null,
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
        if (requestRef.current !== requestId) return;
        hydrationFailedRef.current = false;
        setDetail((current) => {
          const resolvedChat =
            current.chat?.id === chat.id ? resolveEquivalentChat(current.chat, chat) : chat;
          if (
            resolvedChat === current.chat &&
            parent === current.parentChat &&
            !current.loading &&
            current.error === null
          ) {
            return current;
          }
          return {
            chat: resolvedChat,
            parentChat: parent,
            loading: false,
            error: null,
          };
        });
      } catch (error) {
        if (requestRef.current !== requestId) return;
        hydrationFailedRef.current = true;
        setDetail((current) => ({
          ...current,
          loading: false,
          error: !showLoading && current.chat ? current.error : (error as Error).message,
        }));
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
        if (event.method === 'bridge/events/snapshotRequired') {
          if (foregroundHydrationRef.current) return;
          void hydrate(false);
          return;
        }
        if (
          event.method === 'thread/subagent/adopted' &&
          extractNotificationThreadId(event.params) === threadId &&
          (!detailChatRef.current || hydrationFailedRef.current)
        ) {
          void hydrate(true);
        }
      }),
    [hydrate, threadId, ws],
  );

  useEffect(() => {
    const remembered = api.peekChat(threadId);
    if (!remembered) return;
    setDetail((current) => {
      const chat =
        current.chat?.id === remembered.id
          ? resolveEquivalentChat(current.chat, remembered)
          : remembered;
      return chat === current.chat ? current : { ...current, chat };
    });
  }, [agentRuntimeRevision, api, threadId]);

  const summary = useMemo(
    () =>
      relatedAgentThreads.find((candidate) => candidate.id === threadId) ??
      api.peekChatSummary(threadId) ??
      detail.chat,
    [agentRuntimeRevision, api, detail.chat, relatedAgentThreads, threadId],
  );
  const chat = useMemo(() => {
    if (!detail.chat || !summary || summary === detail.chat) return detail.chat;
    if (
      detail.chat.status === summary.status &&
      detail.chat.statusUpdatedAt === summary.statusUpdatedAt &&
      detail.chat.lastError === summary.lastError
    ) {
      return detail.chat;
    }
    return {
      ...detail.chat,
      status: summary.status,
      statusUpdatedAt: summary.statusUpdatedAt,
      lastError: summary.lastError,
    };
  }, [detail.chat, summary]);
  const statusMapRef = useRef<ReadonlyMap<string, Chat['status']>>(new Map());
  const agentThreadStatusById = useMemo(() => {
    const statuses = new Map(
      relatedAgentThreads.map((candidate) => [candidate.id, candidate.status] as const),
    );
    if (chat) statuses.set(chat.id, chat.status);
    if (areChatStatusMapsEquivalent(statusMapRef.current, statuses)) {
      return statusMapRef.current;
    }
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
  const projectedMessageCount = useMemo(() => {
    if (!chat) return 0;
    return projectTranscript({
      chat,
      parentChat: detail.parentChat,
      showToolCalls,
      threadStatuses: agentThreadStatusById,
      liveMessageState,
    }).messages.length;
  }, [agentThreadStatusById, chat, detail.parentChat, liveMessageState, showToolCalls]);

  // A sub-agent that has already stopped is never "starting", even when it left no
  // transcript behind -- otherwise opening a finished agent spins forever.
  const isStarting = Boolean(chat) && chat?.status === 'running' && projectedMessageCount === 0;
  const isEmpty = Boolean(chat) && !isStarting && projectedMessageCount === 0;

  const activityDetail =
    display?.detail ?? runtime?.latestCommand?.detail ?? summary?.agentRole?.trim() ?? null;
  const headingFocusRef = useAccessibilityFocus<Text>(true);
  useAccessibilityAnnouncement(
    detail.error ?? (detail.loading ? 'Loading agent transcript' : null),
  );

  const navigateBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
    } else if (profileId && chatId) {
      router.dismissTo(routes.chat(profileId, chatId));
    }
  }, [chatId, profileId, router]);

  const openSubAgentThread = useCallback(
    (nextThreadId: string) => openSubAgent(nextThreadId),
    [openSubAgent],
  );

  return (
    <SafeAreaView style={styles.page}>
      <View style={styles.header}>
        <Pressable
          onPress={navigateBack}
          hitSlop={8}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel="Back from sub-agent transcript"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chevron-back"
            size={22}
            color={theme.colors.textPrimary}
          />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>Sub-agent</Text>
          <Text
            ref={headingFocusRef}
            accessibilityRole="header"
            style={styles.title}
            numberOfLines={1}
          >
            {title}
          </Text>
        </View>
        <View style={styles.iconButton} />
      </View>

      <View style={styles.statusBar} accessibilityLiveRegion="polite">
        <View style={styles.statusCopy}>
          <View style={styles.statusTitleRow}>
            {display?.isActive ? (
              <ActivityIndicator size="small" color={display.statusColor} />
            ) : (
              <Ionicons
                {...decorativeAccessibilityProps}
                name={display?.icon ?? 'ellipse-outline'}
                size={15}
                color={display?.statusColor ?? theme.colors.textMuted}
              />
            )}
            <Text
              style={[
                styles.statusLabel,
                { color: display?.statusColor ?? theme.colors.textMuted },
              ]}
            >
              {display?.label ?? (detail.loading ? 'Loading' : 'Idle')}
            </Text>
          </View>
          {activityDetail ? (
            <Text style={styles.activityDetail} numberOfLines={2}>
              {activityDetail}
            </Text>
          ) : null}
        </View>
      </View>

      {detail.error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.errorText}
        >
          {detail.error}
        </Text>
      ) : null}

      <View style={styles.transcript}>
        {isStarting ? (
          <View
            style={styles.loadingShell}
            accessibilityRole="progressbar"
            accessibilityLabel="Sub-agent starting"
          >
            <ActivityIndicator color={theme.colors.warning} />
            <Text style={styles.loadingText}>Starting…</Text>
            <Text style={styles.startingHint}>
              This agent has not reported anything yet. Its work will stream in here.
            </Text>
          </View>
        ) : isEmpty ? (
          <View style={styles.loadingShell} accessibilityLabel="Sub-agent reported no transcript">
            <Ionicons
              {...decorativeAccessibilityProps}
              name="document-text-outline"
              size={20}
              color={theme.colors.textMuted}
            />
            <Text style={styles.loadingText}>No transcript</Text>
            <Text style={styles.startingHint}>
              This agent reported back through its parent instead of streaming its own session.
            </Text>
          </View>
        ) : chat ? (
          <ChatTranscriptView
            chat={chat}
            parentChat={detail.parentChat}
            bridgeUrl={bridgeUrl}
            bridgeToken={bridgeToken}
            onOpenLocalPreview={openBrowser}
            showToolCalls={showToolCalls}
            onOpenSubAgentThread={openSubAgentThread}
            agentThreadStatusById={agentThreadStatusById}
            scrollRef={scrollRef}
            inlineChoicesEnabled={false}
            onInlineOptionSelect={() => {}}
            onPinnedAutoScroll={() => {
              if (autoScrollStateRef.current.shouldStickToBottom) {
                scrollRef.current?.scrollToOffset({ offset: 0, animated: false });
              }
            }}
            onJumpToLatest={() => {
              scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
            }}
            onScrollInteractionStart={() => {}}
            autoScrollStateRef={autoScrollStateRef}
            bottomInset={0}
            liveMessageState={liveMessageState}
          />
        ) : (
          <View
            style={styles.loadingShell}
            accessibilityRole="progressbar"
            accessibilityLabel="Loading agent transcript"
          >
            <ActivityIndicator color={theme.colors.textMuted} />
            <Text style={styles.loadingText}>Loading agent transcript…</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    page: {
      flex: 1,
      backgroundColor: theme.colors.bgMain,
    },
    header: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    iconButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerCopy: {
      flex: 1,
      minWidth: 0,
    },
    eyebrow: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 10,
      lineHeight: 12,
      fontWeight: '700',
      textTransform: 'uppercase',
    },
    title: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
      fontSize: 17,
    },
    statusBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.md,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      backgroundColor: theme.colors.bgElevated,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    statusCopy: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    statusTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
    },
    statusLabel: {
      ...theme.typography.caption,
      fontWeight: '700',
    },
    activityDetail: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
    },
    errorText: {
      ...theme.typography.caption,
      color: theme.colors.error,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
    },
    transcript: {
      flex: 1,
    },
    loadingShell: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
    },
    loadingText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
    },
    startingHint: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      textAlign: 'center',
      maxWidth: 260,
      paddingHorizontal: theme.spacing.lg,
    },
  });
