import { useCallback, useRef } from 'react';
import type {
  MainScreenTurnStopControlContext,
  MainScreenTurnStopControlResult,
} from '../turn/stopControl';
import { executeSlashCommand } from './slashCommand';

export type MainScreenSlashCommandHandlerContext = MainScreenTurnStopControlContext &
  MainScreenTurnStopControlResult;

export function useMainScreenSlashCommandHandler(context: MainScreenSlashCommandHandlerContext) {
  // `executeSlashCommand` consumes the whole composition context and reads live screen state from
  // the jotai store at call time. The context object is rebuilt on every render, so it is held in
  // a ref: the handler stays referentially stable for the callbacks and effects that depend on it
  // while still running against the latest context.
  const contextRef = useRef(context);
  contextRef.current = context;

  const handleSlashCommand = useCallback(
    (input: string): Promise<boolean> => executeSlashCommand(contextRef.current, input),
    [],
  );

  return {
    handleSlashCommand,
  };
}

export type MainScreenSlashCommandHandlerResult = ReturnType<
  typeof useMainScreenSlashCommandHandler
>;
