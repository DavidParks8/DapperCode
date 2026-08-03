import { useCallback, useRef, useState } from 'react';

export function useForkConversationAction(
  onForkConversation?: (messageId: string) => Promise<unknown>,
) {
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const forkInFlightRef = useRef(false);
  const handleForkConversation = useCallback(
    (messageId: string) => {
      if (forkInFlightRef.current || !onForkConversation) {
        return;
      }
      forkInFlightRef.current = true;
      setForkingMessageId(messageId);
      void onForkConversation(messageId)
        .catch(() => undefined)
        .finally(() => {
          forkInFlightRef.current = false;
          setForkingMessageId(null);
        });
    },
    [onForkConversation],
  );
  return { forkingMessageId, handleForkConversation };
}
