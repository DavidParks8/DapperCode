import { reduceThreadState } from '@bridge/agui/agUiThreadEventReducer';
import type { AgUiEventEnvelope } from '@bridge/agui/agUi';
import {
  type AgUiMessageState,
  createAgUiThreadMessageState,
} from '@bridge/agui/agUiMessagesState';

export function reduceAgUiMessageState(
  previous: AgUiMessageState,
  envelope: AgUiEventEnvelope,
): AgUiMessageState {
  const current = previous[envelope.threadId] ?? createAgUiThreadMessageState();
  const next = reduceThreadState(current, envelope);
  if (next === current) {
    return previous;
  }
  return { ...previous, [envelope.threadId]: next };
}
