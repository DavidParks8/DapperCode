import { useAtomValue, useStore } from 'jotai';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';

import { usePromoteNewChatRoute } from '@shell/navigation/usePromoteNewChatRoute';
import { ProfileRouteContent, useProfileRouteReady } from '@shell/navigation/ProfileRouteBoundary';
import { MainScreen } from '../../../../../../features/chat/screen/MainScreen';
import {
  chatSnapshotCacheAtom,
  interruptedChatCreationAtom,
  selectedChatIdAtom,
} from '@shell/state/chat/atoms';
import { applyRestoredChatSnapshotAtom } from '@shell/state/chat/actions';
import {
  isPendingChatId,
  readInterruptedChatCreation,
} from '@shell/session/interruptedChatCreation';
import { routes } from '@shell/navigation/routes';

export default function ChatIndexRoute() {
  const { chatId, profileId } = useLocalSearchParams<{ chatId: string; profileId: string }>();
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const profileReady = useProfileRouteReady();

  usePromoteNewChatRoute(chatId, profileReady ? selectedChatId : null);

  return (
    <ProfileRouteContent>
      {isPendingChatId(chatId) ? (
        <InterruptedChatRoute
          key={`${profileId}:${chatId}`}
          profileId={profileId}
          chatId={chatId}
        />
      ) : (
        <MainScreen key={profileId} />
      )}
    </ProfileRouteContent>
  );
}

function InterruptedChatRoute({ profileId, chatId }: { profileId: string; chatId: string }) {
  const store = useStore();
  const [destination, setDestination] = useState<ReturnType<typeof routes.chat> | null>(null);
  useEffect(() => {
    const cache = store.get(chatSnapshotCacheAtom);
    const current = store.get(interruptedChatCreationAtom);
    const snapshot =
      cache?.profileId === profileId &&
      cache.selectedChatId === chatId &&
      (!current || current.pendingChatId === chatId)
        ? (cache.entries.find((entry) => entry.chat.id === chatId)?.chat ?? null)
        : null;
    if (snapshot) {
      store.set(applyRestoredChatSnapshotAtom, snapshot);
    }
    const createdChatId = readInterruptedChatCreation(snapshot)?.createdChatId;
    setDestination(
      createdChatId ? routes.chat(profileId, createdChatId) : routes.newChat(profileId),
    );
  }, [chatId, profileId, store]);
  // Never mount a chat controller that could send the local placeholder ID to the bridge.
  return destination ? <Redirect href={destination} /> : null;
}
