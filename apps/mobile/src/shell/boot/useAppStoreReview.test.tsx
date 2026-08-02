const mockRequestNativeStoreReview = jest.fn().mockResolvedValue(true);
const mockSaveAutoStoreReviewState = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@shell/storeReview', () => ({
  AUTO_STORE_REVIEW_THRESHOLD_MS: 0,
  createDefaultAutoStoreReviewState: () => ({
    accumulatedForegroundMs: 0,
    automaticRequestAt: null,
  }),
  isAutoStoreReviewEligible: () => true,
  loadAutoStoreReviewState: jest.fn().mockResolvedValue({
    accumulatedForegroundMs: 0,
    automaticRequestAt: null,
  }),
  requestNativeStoreReview: () => mockRequestNativeStoreReview(),
  saveAutoStoreReviewState: (state: unknown) => mockSaveAutoStoreReviewState(state),
}));

import { router } from 'expo-router';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

import { createTestStore, withAppStore } from '@shell/state/testing';
import { useAppStoreReview } from '@shell/boot/useAppStoreReview';

function Harness() {
  useAppStoreReview();
  return null;
}

describe('useAppStoreReview route gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
    });
  });

  it('suppresses automatic review during connection and resumes on a chat route', async () => {
    const store = createTestStore();
    router.replace('/profiles/profile-1/chats/new/connection');
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).not.toHaveBeenCalled();

    await act(async () => {
      router.replace('/profiles/profile-1/chats/new');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).toHaveBeenCalledTimes(1);
    expect(mockSaveAutoStoreReviewState).toHaveBeenCalled();
    act(() => tree?.unmount());
  });

  it('measures active usage from commit without resetting the timestamp on rerender', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    let appStateListener: ((state: 'background') => void) | undefined;
    const appStateSubscription = { remove: jest.fn() };
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, listener) => {
        appStateListener = listener;
        return appStateSubscription;
      });
    router.replace('/profiles/profile-1/chats/new/connection');
    const store = createTestStore();
    let tree!: ReactTestRenderer;

    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    now.mockReturnValue(2_000);
    act(() => tree.update(withAppStore(store, <Harness />)));
    now.mockReturnValue(2_500);
    await act(async () => {
      appStateListener?.('background');
      await Promise.resolve();
    });

    expect(mockSaveAutoStoreReviewState).toHaveBeenLastCalledWith(
      expect.objectContaining({ accumulatedForegroundMs: 1_500 }),
    );
    act(() => tree.unmount());
    expect(appStateSubscription.remove).toHaveBeenCalled();
    addEventListener.mockRestore();
    now.mockRestore();
  });
});
