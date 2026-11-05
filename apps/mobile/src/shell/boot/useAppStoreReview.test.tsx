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
import { activeChatAtom } from '@shell/state/chat/atoms';
import { localAgentPresenceAtom } from '@shell/state/local/atoms';
import { storeReviewComposerOwnersAtom } from '@shell/state/storeReview';
import type { Chat } from '@bridge/types/types';

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

  it('defers review while a composer owns focus or an unsent draft, then resumes when it settles', async () => {
    const store = createTestStore();
    const owner = Symbol('typing composer');
    store.set(storeReviewComposerOwnersAtom, new Set([owner]));
    router.replace('/profiles/on-device/chats/new');
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).not.toHaveBeenCalled();
    await act(async () => {
      store.set(storeReviewComposerOwnersAtom, new Set());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it('defers review during a running turn and its tool approval until the turn settles', async () => {
    const store = createTestStore();
    const chat: Chat = {
      id: 'local-review-turn',
      title: 'Local work',
      status: 'running',
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
      statusUpdatedAt: '2026-11-04T00:00:00.000Z',
      lastMessagePreview: '',
      messages: [],
    };
    store.set(activeChatAtom, chat);
    router.replace('/profiles/on-device/chats/local-review-turn');
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).not.toHaveBeenCalled();

    await act(async () => {
      store.set(activeChatAtom, { ...chat, lastMessagePreview: 'Waiting for approval' });
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).not.toHaveBeenCalled();

    await act(async () => {
      store.set(activeChatAtom, { ...chat, status: 'idle' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).toHaveBeenCalledTimes(1);
    expect(mockSaveAutoStoreReviewState).toHaveBeenLastCalledWith(
      expect.objectContaining({ automaticRequestAt: expect.any(String) }),
    );
    act(() => tree.unmount());
  });

  it.each([
    ['busy', 'Loading model'],
    ['attention', 'Waiting for approval'],
    ['error', 'Model failed to load'],
  ] as const)('defers review during local %s even without a selected chat', async (kind, label) => {
    const store = createTestStore();
    store.set(localAgentPresenceAtom, {
      status: { kind, label },
      readiness: null,
      defaultWorkspacePath: null,
    });
    router.replace('/profiles/on-device/chats/new');
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).not.toHaveBeenCalled();

    await act(async () => {
      store.set(localAgentPresenceAtom, {
        status: { kind: 'ready', label: 'Ready' },
        readiness: null,
        defaultWorkspacePath: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it.each([
    '/profiles/on-device/settings/models',
    '/profiles/on-device/chats/working/files',
    '/profiles/on-device/chats/working/git',
  ] as const)('defers automatic review on the task surface %s', async (path) => {
    const store = createTestStore();
    router.replace(path);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).not.toHaveBeenCalled();

    await act(async () => {
      router.replace('/profiles/on-device/chats/new');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRequestNativeStoreReview).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
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
