import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { View, type FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatInput } from '../../chat/composer/ChatInput';
import { useKeyboardFrameTracking } from '../../chat/session/keyboardLayout';
import { ChatTranscriptView } from '../../chat/transcript/ChatTranscriptView';
import type { TranscriptDisplayItem } from '../../chat/transcript/messages';
import type { AutoScrollState } from '../../chat/helpers/helpers';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { localChatProjection } from '../runtime/chatProjection';
import type { OnDeviceRuntimeSlice } from '../runtime/types';
import { localChatControls } from './chatControls';
import { GitTransferProgress } from './GitTransferProgress';
import { LocalAction, LocalError, LocalPage, LocalText, useLocalOperation } from './ui';

const NO_THREAD_STATUSES = new Map();
const noAction = () => undefined;
const CHAT_SLICES: readonly OnDeviceRuntimeSlice[] = [
  'threads',
  'loop',
  'models',
  'workspaces',
  'issues',
];

export function LocalChatScreen() {
  const runtime = useOnDeviceRuntime(CHAT_SLICES);
  const { threadId = '' } = useLocalSearchParams<{ threadId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const thread = runtime.threads.list().find((entry) => entry.id === threadId);
  const [draft, setDraft] = useState(() => runtime.draft(threadId));
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  useKeyboardFrameTracking(setKeyboardVisible, setKeyboardInset);
  const operation = useLocalOperation();
  const stop = useLocalOperation();
  const scroll = useRef<FlatList<TranscriptDisplayItem>>(null);
  const autoScroll = useRef<AutoScrollState>({
    shouldStickToBottom: true,
    isUserInteracting: false,
    isMomentumScrolling: false,
  });
  const workspace = runtime.workspaces().find((entry) => entry.id === thread?.workspaceId);
  const workspaceName = workspace?.name ?? 'Unavailable workspace';
  const chat = useMemo(
    () => (thread ? localChatProjection(thread, workspaceName) : null),
    [thread, workspaceName],
  );
  if (!thread || !chat) {
    return (
      <LocalPage
        title="Local conversation"
        error="This conversation is unavailable. Stored data has not been reset."
      />
    );
  }
  const issues = runtime
    .issues()
    .filter((issue) => issue.threadId === null || issue.threadId === threadId);
  const errors = [
    ...new Set(
      [
        operation.error,
        stop.error,
        ...issues.map((issue) => issue.message),
        thread.lastError,
      ].filter((message): message is string => Boolean(message)),
    ),
  ];
  const controls = localChatControls(
    thread,
    runtime.loop.snapshot(),
    runtime.models.snapshot(),
    runtime.workspaceActivity(),
  );
  const jump = () => scroll.current?.scrollToOffset({ offset: 0, animated: true });
  return (
    <LocalPage title={thread.title} scroll={false}>
      <View testID="on-device-chat-body" style={{ flex: 1, paddingBottom: keyboardInset }}>
        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <LocalText>{controls.status}</LocalText>
          <GitTransferProgress watch={controls.isLoading} />
          {errors.map((message) => (
            <LocalError key={message} message={message} />
          ))}
          {issues.length > 0 || (thread.lastError && thread.status !== 'running') ? (
            <LocalAction
              title="Dismiss"
              onPress={() => {
                for (const issue of issues) {
                  runtime.dismissIssue(issue.id);
                }
                void runtime
                  .dismissThreadError(threadId)
                  .catch((failure: unknown) => runtime.report(failure, threadId));
              }}
            />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <LocalAction
              title="Model"
              disabled={controls.isLoading}
              onPress={() => router.push({ pathname: '/on-device/models', params: { threadId } })}
            />
            <LocalAction
              title="Git"
              onPress={() =>
                router.push({
                  pathname: '/on-device/git',
                  params: { workspaceId: thread.workspaceId },
                })
              }
            />
            <LocalAction
              title="Files"
              onPress={() =>
                router.push({
                  pathname: '/on-device/files',
                  params: { workspaceId: thread.workspaceId },
                })
              }
            />
          </View>
        </View>
        <ChatTranscriptView
          chat={chat}
          parentChat={null}
          bridgeUrl=""
          bridgeToken={null}
          showToolCalls
          agentThreadStatusById={NO_THREAD_STATUSES}
          scrollRef={scroll}
          inlineChoicesEnabled={false}
          onInlineOptionSelect={noAction}
          onPinnedAutoScroll={jump}
          onJumpToLatest={jump}
          onScrollInteractionStart={noAction}
          autoScrollStateRef={autoScroll}
          bottomInset={16}
        />
        <ChatInput
          value={draft}
          onChangeText={(text) => {
            setDraft(text);
            runtime.setDraft(threadId, text);
          }}
          onSubmit={() =>
            operation.run(() =>
              runtime.sendMessage(threadId, draft, randomUUID(), () => {
                setDraft('');
                runtime.setDraft(threadId, '');
              }),
            )
          }
          onStop={() => stop.run(() => runtime.stop())}
          onAttachPress={noAction}
          attachDisabled
          isLoading={controls.isLoading}
          showStopButton={controls.showStopButton}
          isStopping={controls.isStopping}
          submitDisabled={controls.submitDisabled || operation.busy || !workspace}
          placeholder="Ask your offline coding agent…"
          safeAreaBottomInset={insets.bottom}
          keyboardVisible={keyboardVisible}
          footer={
            <LocalText>
              {thread.modelId} · {workspace?.name ?? 'Workspace unavailable'}
            </LocalText>
          }
        />
      </View>
    </LocalPage>
  );
}
