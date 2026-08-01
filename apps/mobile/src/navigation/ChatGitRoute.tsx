import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import type { Chat } from '../api/types';
import { useBridgeApi } from '../state/bridge/hooks';
import { activeChatAtom, gitChatAtom } from '../state/chat/atoms';
import { GitScreen } from '../screens/git/GitScreen';
import { useAppTheme } from '../theme';
import { RouteErrorScreen } from './RouteErrorScreen';

export function ChatGitRoute({ chatId }: { chatId: string }) {
  const api = useBridgeApi();
  const theme = useAppTheme();
  const gitChat = useAtomValue(gitChatAtom);
  const activeChat = useAtomValue(activeChatAtom);
  const [loadedChat, setLoadedChat] = useState<Chat | null>(
    gitChat?.id === chatId
      ? gitChat
      : activeChat?.id === chatId
        ? activeChat
        : (api.peekChat(chatId) ?? api.peekChatShell(chatId)),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loadedChat?.id === chatId) {
      return;
    }
    let cancelled = false;
    void api
      .getChat(chatId)
      .then((chat) => {
        if (!cancelled) {
          setLoadedChat(chat);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'The chat could not be loaded.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, chatId, loadedChat]);

  if (error) {
    return <RouteErrorScreen title="Could not open Git" message={error} />;
  }

  if (!loadedChat) {
    return (
      <View
        style={[styles.loading, { backgroundColor: theme.colors.bgMain }]}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading Git chat"
      >
        <ActivityIndicator color={theme.colors.textPrimary} />
      </View>
    );
  }

  return <GitScreen chat={loadedChat} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
