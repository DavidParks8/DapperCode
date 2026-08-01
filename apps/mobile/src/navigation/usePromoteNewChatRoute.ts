import { useNavigation } from 'expo-router';
import { useEffect } from 'react';

export function usePromoteNewChatRoute(chatId: string, selectedChatId: string | null): void {
  const navigation = useNavigation<{ setParams: (params: { chatId: string }) => void }>();

  useEffect(() => {
    if (chatId === 'new' && selectedChatId && !selectedChatId.startsWith('pending-')) {
      navigation.setParams({ chatId: selectedChatId });
    }
  }, [chatId, navigation, selectedChatId]);
}
