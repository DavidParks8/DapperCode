import { randomUUID } from 'expo-crypto';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { View, type FlatList } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatInput } from '../../chat/composer/ChatInput';
import { useKeyboardFrameTracking } from '../../chat/session/keyboardLayout';
import { ChatTranscriptView } from '../../chat/transcript/ChatTranscriptView';
import type { TranscriptDisplayItem } from '../../chat/transcript/messages';
import type { AutoScrollState } from '../../chat/helpers/helpers';
import { findLocalModelDefinition, localModelDisplayName } from '../models/catalog';
import type { LocalToolApproval } from '../runtime/agentLoop';
import { useOnDeviceRuntime } from '../runtime/OnDeviceProvider';
import { localChatProjection } from '../runtime/chatProjection';
import { localChatControls } from './chatControls';
import { GitTransferProgress } from './GitTransferProgress';
import { LocalAction, LocalError, LocalPage, LocalText, useLocalOperation } from './ui';

const NO_THREAD_STATUSES = new Map();
const noAction = () => undefined;

export function LocalChatScreen() {
  const runtime = useOnDeviceRuntime();
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
  if (!thread) {
    return (
      <LocalPage
        title="Local conversation"
        error="This conversation is unavailable. Stored data has not been reset."
      />
    );
  }
  const workspace = runtime.workspaces().find((entry) => entry.id === thread.workspaceId);
  const chat = localChatProjection(thread, workspace?.name ?? 'Unavailable workspace');
  const controls = localChatControls(
    thread,
    runtime.loop.snapshot(),
    runtime.models.snapshot(),
    runtime.workspaceActivity(),
    findLocalModelDefinition(thread.modelId) ? runtime.downloads.snapshot(thread.modelId) : null,
  );

  const jump = () => scroll.current?.scrollToOffset({ offset: 0, animated: true });
  return (
    <LocalPage title={thread.title} scroll={false}>
      <View testID="on-device-chat-body" style={{ flex: 1, paddingBottom: keyboardInset }}>
        <View style={{ paddingHorizontal: 16, gap: 8 }}>
          <LocalText>{controls.status}</LocalText>
          <GitTransferProgress watch={controls.isLoading} />
          <LocalError
            message={
              operation.error ??
              stop.error ??
              runtime.error()?.message ??
              thread.lastError ??
              controls.statusDetail
            }
          />
          <LocalTurnActions
            approval={controls.approval}
            canRetry={controls.canRetry}
            busy={operation.busy}
            onRetry={() => operation.run(() => runtime.retryTurn(threadId))}
          />
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
              {localModelDisplayName(thread.modelId)} · {workspace?.name ?? 'Workspace unavailable'}
            </LocalText>
          }
        />
      </View>
    </LocalPage>
  );
}

function LocalTurnActions({
  approval,
  canRetry,
  busy,
  onRetry,
}: {
  approval: LocalToolApproval | null;
  canRetry: boolean;
  busy: boolean;
  onRetry: () => void;
}) {
  const runtime = useOnDeviceRuntime();
  const decide = (approved: boolean) => {
    if (!approval) {
      return;
    }
    try {
      runtime.loop.resolveApproval(approval.callId, approved);
    } catch (error) {
      runtime.report(error);
    }
  };
  if (approval) {
    return (
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <LocalAction
          title={`Allow: ${approval.summary}`}
          testID="on-device-approve-tool"
          onPress={() => decide(true)}
        />
        <LocalAction
          title="Decline"
          destructive
          testID="on-device-decline-tool"
          onPress={() => decide(false)}
        />
      </View>
    );
  }
  return canRetry ? (
    <LocalAction
      title="Retry last turn"
      testID="on-device-retry-turn"
      disabled={busy}
      onPress={onRetry}
    />
  ) : null;
}
