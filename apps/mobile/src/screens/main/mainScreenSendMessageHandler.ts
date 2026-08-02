import { useCallback, useRef } from 'react';
import type {
  MainScreenChatCreationFlowContext,
  MainScreenChatCreationFlowResult,
} from './mainScreenChatCreationFlow';
import { executeSendMessage, type SendMessageOptions } from './mainScreenSendMessage';

export type MainScreenSendMessageHandlerContext = MainScreenChatCreationFlowContext &
  MainScreenChatCreationFlowResult;

export function useMainScreenSendMessageHandler(context: MainScreenSendMessageHandlerContext) {
  // `executeSendMessage` consumes the whole composition context and reads live screen state from
  // the jotai store at call time. The context object is rebuilt on every render, so it is held in
  // a ref: the sender stays referentially stable for the callbacks, refs and effects that depend
  // on it while still running against the latest context.
  const contextRef = useRef(context);
  contextRef.current = context;

  const sendMessageContent = useCallback(
    (rawContent: string, options?: SendMessageOptions) =>
      executeSendMessage(contextRef.current, rawContent, options),
    [],
  );

  return {
    sendMessageContent,
  };
}

export type MainScreenSendMessageHandlerResult = ReturnType<typeof useMainScreenSendMessageHandler>;
