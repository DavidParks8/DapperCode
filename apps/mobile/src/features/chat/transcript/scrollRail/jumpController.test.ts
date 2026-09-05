import {
  CHAT_SCROLL_RAIL_JUMP_RETRY_DELAY_MS,
  CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT,
  createChatScrollRailJumpController,
} from './jumpController';

describe('chat scroll rail jump controller', () => {
  it('reveals an unpaged anchor and jumps after data updates', () => {
    let displayIndex: number | null = null;
    const revealTranscriptIndex = jest.fn();
    const scrollToIndex = jest.fn();
    const controller = createChatScrollRailJumpController({
      resolveDisplayIndex: () => displayIndex,
      revealTranscriptIndex,
      scrollToIndex,
      scrollToOffset: jest.fn(),
    });

    controller.request({ messageId: 'old', transcriptIndex: 12 });
    expect(revealTranscriptIndex).toHaveBeenCalledWith(12);
    expect(scrollToIndex).not.toHaveBeenCalled();

    displayIndex = 87;
    controller.notifyDataChanged();
    expect(scrollToIndex).toHaveBeenCalledWith(87);
    controller.notifyDataChanged();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
  });

  it('estimates failed offsets and retries on layout progress', () => {
    const controllerRef: {
      current: ReturnType<typeof createChatScrollRailJumpController> | null;
    } = { current: null };
    const scrollToOffset = jest.fn();
    const cancelScheduled = jest.fn();
    const schedule = jest.fn(() => 42 as unknown as ReturnType<typeof setTimeout>);
    const scrollToIndex = jest.fn((index: number) => {
      if (scrollToIndex.mock.calls.length === 1) {
        controllerRef.current?.handleScrollToIndexFailed({
          index,
          highestMeasuredFrameIndex: 12,
          averageItemLength: 64,
        });
      }
    });
    const controller = createChatScrollRailJumpController({
      resolveDisplayIndex: () => 40,
      revealTranscriptIndex: jest.fn(),
      scrollToIndex,
      scrollToOffset,
      schedule,
      cancelScheduled,
    });
    controllerRef.current = controller;

    controller.request({ messageId: 'target', transcriptIndex: 10 });
    expect(scrollToOffset).toHaveBeenCalledWith(2560);
    expect(schedule).toHaveBeenCalledWith(
      expect.any(Function),
      CHAT_SCROLL_RAIL_JUMP_RETRY_DELAY_MS,
    );

    controller.notifyLayoutProgress();
    expect(cancelScheduled).toHaveBeenCalled();
    expect(scrollToIndex).toHaveBeenCalledTimes(2);
  });

  it('cancels stale retries when a newer target wins', () => {
    const callbacks: Array<() => void> = [];
    const controllerRef: {
      current: ReturnType<typeof createChatScrollRailJumpController> | null;
    } = { current: null };
    let index = 20;
    const scrollToIndex = jest.fn((attemptedIndex: number) => {
      if (attemptedIndex === 20) {
        controllerRef.current?.handleScrollToIndexFailed({
          index: attemptedIndex,
          highestMeasuredFrameIndex: 4,
          averageItemLength: 50,
        });
      }
    });
    const controller = createChatScrollRailJumpController({
      resolveDisplayIndex: () => index,
      revealTranscriptIndex: jest.fn(),
      scrollToIndex,
      scrollToOffset: jest.fn(),
      schedule: (callback) => {
        callbacks.push(callback);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancelScheduled: jest.fn(),
    });
    controllerRef.current = controller;

    controller.request({ messageId: 'first', transcriptIndex: 1 });
    index = 8;
    controller.request({ messageId: 'second', transcriptIndex: 9 });
    callbacks[0]?.();

    expect(scrollToIndex.mock.calls).toEqual([[20], [8]]);
  });

  it('resumes a stalled jump when new cells are measured and the paged target moves', () => {
    jest.useFakeTimers();
    let displayIndex = 929;
    let highestMeasuredFrameIndex = 69;
    const scrollToOffset = jest.fn();
    const controller = createChatScrollRailJumpController({
      resolveDisplayIndex: () => displayIndex,
      revealTranscriptIndex: jest.fn(),
      scrollToIndex: (index) => {
        if (index > highestMeasuredFrameIndex) {
          controller.handleScrollToIndexFailed({
            index,
            highestMeasuredFrameIndex,
            averageItemLength: 64,
          });
        }
      },
      scrollToOffset,
    });
    try {
      controller.request({ messageId: 'kickoff', transcriptIndex: 0 });
      jest.runAllTimers();
      expect(scrollToOffset).toHaveBeenCalledTimes(CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT);

      displayIndex = 1025;
      controller.notifyDataChanged();
      expect(scrollToOffset).toHaveBeenCalledTimes(CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT);

      highestMeasuredFrameIndex = 300;
      controller.notifyLayoutProgress();
      expect(scrollToOffset).toHaveBeenLastCalledWith(1025 * 64);
      jest.runAllTimers();
      expect(scrollToOffset).toHaveBeenCalledTimes(CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT * 2);

      highestMeasuredFrameIndex = displayIndex;
      controller.notifyLayoutProgress();
      const settledCount = scrollToOffset.mock.calls.length;
      displayIndex += 1;
      controller.notifyDataChanged();
      jest.runAllTimers();
      expect(scrollToOffset).toHaveBeenCalledTimes(settledCount);
    } finally {
      controller.cancel();
      jest.useRealTimers();
    }
  });

  it('caps failures and ignores unrelated or cancelled failures', () => {
    const controllerRef: {
      current: ReturnType<typeof createChatScrollRailJumpController> | null;
    } = { current: null };
    const scrollToOffset = jest.fn();
    const scrollToIndex = jest.fn((index: number) => {
      controllerRef.current?.handleScrollToIndexFailed({
        index,
        highestMeasuredFrameIndex: 1,
        averageItemLength: 20,
      });
    });
    const controller = createChatScrollRailJumpController({
      resolveDisplayIndex: () => 6,
      revealTranscriptIndex: jest.fn(),
      scrollToIndex,
      scrollToOffset,
      schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
      cancelScheduled: jest.fn(),
    });
    controllerRef.current = controller;
    controller.request({ messageId: 'target', transcriptIndex: 3 });
    controller.handleScrollToIndexFailed({
      index: 2,
      highestMeasuredFrameIndex: 1,
      averageItemLength: 20,
    });
    for (let attempt = 0; attempt < CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT + 2; attempt += 1) {
      controller.notifyLayoutProgress();
    }
    expect(scrollToOffset).toHaveBeenCalledTimes(CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT);

    controller.cancel();
    controller.handleScrollToIndexFailed({
      index: 6,
      highestMeasuredFrameIndex: 1,
      averageItemLength: 20,
    });
    expect(scrollToOffset).toHaveBeenCalledTimes(CHAT_SCROLL_RAIL_JUMP_RETRY_LIMIT);
  });
});
