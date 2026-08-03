import type { Chat } from '@bridge/types/types';
import { resolveEquivalentChat } from '../state/chatState';

type AcceptedTurnStateArgs = {
  result: { turnId: string | null; chat: Chat | null };
  targetChatId: string;
  selectedChatRef: { current: Chat | null };
  registerTurnStarted: (threadId: string, turnId: string) => void;
  interruptLatestTurn: (threadId: string) => Promise<void>;
  setActiveTurnId: (value: string | null) => void;
  setStoppingTurn: (value: boolean) => void;
  stopRequestedRef: { current: boolean };
  mergeChatWithPendingOptimisticMessages: (chat: Chat) => Chat;
  setSelectedChat: (value: Chat) => void;
  setShowDelayedGenericRunningActivity: (value: boolean) => void;
  setActivity: (value: { tone: 'running'; title: string }) => void;
  bumpRunWatchdog: () => void;
};

function handleAcceptedTurnWithoutId(args: AcceptedTurnStateArgs): void {
  args.setActiveTurnId(null);
  if (args.stopRequestedRef.current) {
    void args.interruptLatestTurn(args.targetChatId);
    return;
  }
  args.setStoppingTurn(false);
}

export function registerAcceptedTurn(args: AcceptedTurnStateArgs, isStillSelected: boolean): void {
  const selectedChat =
    isStillSelected && args.selectedChatRef.current?.id === args.targetChatId
      ? args.selectedChatRef.current
      : null;
  const alreadySettled = selectedChat?.status === 'complete' || selectedChat?.status === 'error';
  if (args.result.turnId && !alreadySettled) {
    args.registerTurnStarted(args.targetChatId, args.result.turnId);
  }
  if (!isStillSelected) {
    return;
  }
  if (!args.result.turnId) {
    handleAcceptedTurnWithoutId(args);
    return;
  }
  if (alreadySettled) {
    return;
  }
  args.setStoppingTurn(false);
  args.stopRequestedRef.current = false;
}

export function applyPendingAcceptedTurn(
  args: AcceptedTurnStateArgs,
  resolvedChat: Chat | null,
): boolean {
  if (args.result.chat !== null) {
    return false;
  }
  if (resolvedChat?.status === 'complete' || resolvedChat?.status === 'error') {
    return true;
  }

  if (resolvedChat) {
    const nowIso = new Date().toISOString();
    const runningChat: Chat = {
      ...resolvedChat,
      status: 'running',
      updatedAt: nowIso,
      statusUpdatedAt: nowIso,
      lastError: undefined,
    };
    args.selectedChatRef.current = runningChat;
    args.setSelectedChat(runningChat);
  }
  args.setShowDelayedGenericRunningActivity(true);
  args.setActivity({ tone: 'running', title: 'Working' });
  args.bumpRunWatchdog();
  return true;
}

export function resolveAcceptedTurnChat(
  args: AcceptedTurnStateArgs,
  currentChat: Chat | null,
): Chat | null {
  if (currentChat?.status === 'complete' || currentChat?.status === 'error') {
    return args.mergeChatWithPendingOptimisticMessages(currentChat);
  }
  if (!args.result.chat) {
    return currentChat;
  }
  return args.mergeChatWithPendingOptimisticMessages(
    currentChat ? resolveEquivalentChat(currentChat, args.result.chat) : args.result.chat,
  );
}
