import { useEffect, type ReactNode } from 'react';
import { AppState, Text, type AppStateStatus } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('react-native-reanimated', () => jest.requireActual('@shared/testing/reanimatedMock'));

import {
  advanceMockAnimationFrame,
  mockFrameCallbacks,
  resetMockFrameCallbacks,
} from '@shared/testing/reanimatedMock';
import { ChatAnimationClockProvider, useChatAnimationTime } from './ChatAnimationClock';

function ClockConsumer({ active, name }: { active: boolean; name: string }) {
  const elapsedMs = useChatAnimationTime(active);
  useEffect(() => {
    void elapsedMs.value;
  }, [elapsedMs]);
  return <Text>{name}</Text>;
}

function harness(children: ReactNode): React.ReactElement {
  return <ChatAnimationClockProvider>{children}</ChatAnimationClockProvider>;
}

describe('ChatAnimationClockProvider', () => {
  let appStateListener: ((state: AppStateStatus) => void) | null;
  let removeAppStateListener: jest.Mock;
  let appStateSpy: jest.SpyInstance;

  beforeEach(() => {
    resetMockFrameCallbacks();
    appStateListener = null;
    removeAppStateListener = jest.fn();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    appStateSpy = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        appStateListener = listener;
        return { remove: removeAppStateListener };
      });
  });

  afterEach(() => {
    appStateSpy.mockRestore();
  });

  it('drives multiple active animations from one foreground frame callback', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        harness(
          <>
            <ClockConsumer active name="atom" />
            <ClockConsumer active name="shimmer" />
          </>,
        ),
      );
    });

    expect(mockFrameCallbacks).toHaveLength(1);
    expect(mockFrameCallbacks[0]?.active).toBe(true);
    act(() => advanceMockAnimationFrame(16));
    expect(mockFrameCallbacks[0]?.elapsedMs).toBe(16);

    act(() => tree?.unmount());
    expect(mockFrameCallbacks[0]?.active).toBe(false);
    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
  });

  it('pauses all registered animations while the app is backgrounded', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(harness(<ClockConsumer active name="atom" />));
    });
    const frameCallback = mockFrameCallbacks[0];
    expect(frameCallback?.active).toBe(true);

    act(() => appStateListener?.('background'));
    expect(frameCallback?.active).toBe(false);
    act(() => advanceMockAnimationFrame(32));
    expect(frameCallback?.elapsedMs).toBe(0);

    act(() => appStateListener?.('active'));
    expect(frameCallback?.active).toBe(true);
    act(() => tree?.unmount());
  });

  it('does not schedule frames when every animation is inactive', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        harness(
          <>
            <ClockConsumer active={false} name="atom" />
            <ClockConsumer active={false} name="shimmer" />
          </>,
        ),
      );
    });

    expect(mockFrameCallbacks).toHaveLength(1);
    expect(mockFrameCallbacks[0]?.active).toBe(false);
    act(() => tree?.unmount());
  });

  it('keeps stale bridge-backed animations frozen while disconnected', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <ChatAnimationClockProvider enabled={false}>
          <ClockConsumer active name="stale activity" />
        </ChatAnimationClockProvider>,
      );
    });

    expect(mockFrameCallbacks[0]?.active).toBe(false);
    act(() => tree?.unmount());
  });
});
