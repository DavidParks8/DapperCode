export const CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT = 3;
export const CHAT_SCROLL_RAIL_JUMP_RETRY_DELAY_MS = 48;

export interface ChatScrollRailJumpTarget {
  messageId: string;
  transcriptIndex: number;
}

export interface ChatScrollRailJumpFailure {
  index: number;
  highestMeasuredFrameIndex: number;
  averageItemLength: number;
}

export interface ChatScrollRailJumpDependencies {
  resolveDisplayIndex: (messageId: string) => number | null;
  revealTranscriptIndex: (transcriptIndex: number) => void;
  scrollToIndex: (index: number) => void;
  scrollToOffset: (offset: number) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelScheduled?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface PendingJump {
  generation: number;
  target: ChatScrollRailJumpTarget;
  displayIndex: number | null;
  retries: number;
  highestMeasuredFrameIndex: number;
  awaitingProgress: boolean;
}

export interface ChatScrollRailJumpController {
  request: (target: ChatScrollRailJumpTarget) => void;
  notifyDataChanged: () => void;
  notifyLayoutProgress: () => void;
  handleScrollToIndexFailed: (failure: ChatScrollRailJumpFailure) => void;
  cancel: () => void;
}

export function createChatScrollRailJumpController(
  dependencies: ChatScrollRailJumpDependencies,
): ChatScrollRailJumpController {
  const schedule = dependencies.schedule ?? setTimeout;
  const cancelScheduled = dependencies.cancelScheduled ?? clearTimeout;
  let generation = 0;
  let pending: PendingJump | null = null;
  let retryHandle: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryHandle !== null) {
      cancelScheduled(retryHandle);
      retryHandle = null;
    }
  };

  const attempt = (expectedGeneration: number) => {
    if (!pending || pending.generation !== expectedGeneration) {
      return;
    }
    const displayIndex = dependencies.resolveDisplayIndex(pending.target.messageId);
    if (displayIndex === null) {
      dependencies.revealTranscriptIndex(pending.target.transcriptIndex);
      pending.displayIndex = null;
      return;
    }
    pending.displayIndex = displayIndex;
    pending.awaitingProgress = false;
    const attemptedJump = pending;
    dependencies.scrollToIndex(displayIndex);
    // VirtualizedList reports missing frame metrics synchronously from scrollToIndex. If that did
    // not happen, this request is settled and future transcript updates must not replay the jump.
    if (pending === attemptedJump && !pending.awaitingProgress) {
      pending = null;
    }
  };

  const scheduleRetry = (expectedGeneration: number) => {
    clearRetry();
    retryHandle = schedule(() => {
      retryHandle = null;
      if (!pending || pending.generation !== expectedGeneration || !pending.awaitingProgress) {
        return;
      }
      attempt(expectedGeneration);
    }, CHAT_SCROLL_RAIL_JUMP_RETRY_DELAY_MS);
  };

  return {
    request(target) {
      clearRetry();
      generation += 1;
      pending = {
        generation,
        target,
        displayIndex: null,
        retries: 0,
        highestMeasuredFrameIndex: -1,
        awaitingProgress: false,
      };
      attempt(generation);
    },
    notifyDataChanged() {
      if (!pending) {
        return;
      }
      attempt(pending.generation);
    },
    notifyLayoutProgress() {
      if (!pending?.awaitingProgress) {
        return;
      }
      clearRetry();
      attempt(pending.generation);
    },
    handleScrollToIndexFailed(failure) {
      if (!pending || pending.displayIndex !== failure.index) {
        return;
      }
      pending.awaitingProgress = true;
      // Exhausted estimates are not a successful jump. Resume only when the list measures
      // more cells; large recovered transcripts cannot reach a distant anchor in three batches.
      if (failure.highestMeasuredFrameIndex > pending.highestMeasuredFrameIndex) {
        pending.highestMeasuredFrameIndex = failure.highestMeasuredFrameIndex;
        pending.retries = 0;
      }
      if (pending.retries >= CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT) {
        return;
      }
      pending.retries += 1;
      const measuredIndex = Math.max(0, failure.highestMeasuredFrameIndex);
      const estimatedIndex = Math.max(measuredIndex, failure.index);
      dependencies.scrollToOffset(estimatedIndex * Math.max(1, failure.averageItemLength));
      scheduleRetry(pending.generation);
    },
    cancel() {
      clearRetry();
      generation += 1;
      pending = null;
    },
  };
}
