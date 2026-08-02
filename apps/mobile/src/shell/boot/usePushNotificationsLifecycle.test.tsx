const mockRemove = jest.fn();
const mockSetupNotificationHandler = jest.fn();
const mockRegisterNotificationCategories = jest.fn().mockResolvedValue(undefined);
const mockGetInitialNotificationResponse = jest.fn().mockResolvedValue(null);
const mockAddNotificationResponseListener = jest.fn();
const mockControllerSetProfile = jest.fn();
const mockControllerDispose = jest.fn();
let mockLiveResponseHandler: ((event: PushResponseEvent) => void) | null = null;
let mockControllerNavigate: ((event: PushResponseEvent) => void) | null = null;

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@shell/push/notifications', () => ({
  addNotificationResponseListener: (handler: (event: PushResponseEvent) => void) => {
    mockLiveResponseHandler = handler;
    mockAddNotificationResponseListener(handler);
    return { remove: mockRemove };
  },
  getInitialNotificationResponse: () => mockGetInitialNotificationResponse(),
  registerNotificationCategories: () => mockRegisterNotificationCategories(),
  setupNotificationHandler: () => mockSetupNotificationHandler(),
}));
jest.mock('@shell/push/responseController', () => ({
  PushResponseController: class {
    constructor(navigate: (event: PushResponseEvent) => void) {
      mockControllerNavigate = navigate;
    }
    handle(event: PushResponseEvent) {
      mockControllerNavigate?.(event);
      return true;
    }
    setProfile(profile: unknown) {
      mockControllerSetProfile(profile);
    }
    dispose() {
      mockControllerDispose();
    }
  },
}));

import { router } from 'expo-router';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { HostBridgeWsClient } from '@bridge/ws/ws';
import type { PushResponseEvent } from '@shell/push/notifications';
import { routes } from '@shell/navigation/routes';
import { appStateSnapshotAtom } from '@shell/state/appState/atoms';
import { pendingMainChatIdAtom } from '@shell/state/chat/atoms';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { usePushNotificationsLifecycle } from '@shell/boot/usePushNotificationsLifecycle';

function event(threadId: string | null): PushResponseEvent {
  return {
    actionId: 'notification:default',
    action: 'default',
    target: {
      type: 'turnCompleted',
      notificationId: 'notification',
      profileId: 'profile-1',
      registrationId: 'registration-1',
      threadId,
      approvalId: null,
    },
  };
}

function Harness() {
  usePushNotificationsLifecycle();
  return null;
}

describe('usePushNotificationsLifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLiveResponseHandler = null;
    mockControllerNavigate = null;
    mockGetInitialNotificationResponse.mockResolvedValue(null);
  });

  it('registers the active profile and routes live thread responses', async () => {
    const api = {} as HostBridgeApiClient;
    const ws = {} as HostBridgeWsClient;
    const store = createBridgeTestStore({ api, ws });
    const snapshot = store.get(appStateSnapshotAtom);
    store.set(appStateSnapshotAtom, {
      ...snapshot,
      data: {
        ...snapshot.data,
        push: {
          ...snapshot.data.push,
          registrations: [
            {
              profileId: 'profile-1',
              registrationId: 'registration-1',
              token: 'token',
            },
          ],
        },
      },
    });
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });

    expect(mockSetupNotificationHandler).toHaveBeenCalled();
    expect(mockRegisterNotificationCategories).toHaveBeenCalled();
    expect(mockAddNotificationResponseListener).toHaveBeenCalled();
    expect(mockControllerSetProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'profile-1',
        registrationId: 'registration-1',
        api,
        ws,
      }),
    );

    act(() => mockLiveResponseHandler?.(event('chat-1')));
    expect(store.get(pendingMainChatIdAtom)).toBe('chat-1');
    expect(router.replace).toHaveBeenCalledWith(routes.chat('profile-1', 'chat-1'));

    act(() => tree?.unmount());
    expect(mockRemove).toHaveBeenCalled();
    expect(mockControllerDispose).toHaveBeenCalled();
  });

  it('does not navigate for a response without a thread', async () => {
    const store = createBridgeTestStore({
      api: {} as HostBridgeApiClient,
      ws: {} as HostBridgeWsClient,
    });
    let tree: ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(withAppStore(store, <Harness />));
      await Promise.resolve();
    });

    act(() => mockLiveResponseHandler?.(event(null)));
    expect(router.replace).not.toHaveBeenCalled();
    act(() => tree?.unmount());
  });
});
