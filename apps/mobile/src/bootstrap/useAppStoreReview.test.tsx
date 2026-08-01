const mockRequestNativeStoreReview = jest.fn().mockResolvedValue(true);
const mockSaveAutoStoreReviewState = jest.fn().mockResolvedValue(undefined);

jest.mock('expo-router', () => jest.requireActual('../testing/expoRouterMock'));
jest.mock('../storeReview', () => ({
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

import { createTestStore, withAppStore } from '../state/testing';
import { useAppStoreReview } from './useAppStoreReview';

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
});
