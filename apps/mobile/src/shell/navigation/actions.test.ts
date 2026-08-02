import { router } from 'expo-router';
jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat } from '@bridge/types/types';
import { routes } from '@shell/navigation/routes';
import { createBridgeTestStore, createTestStore } from '@shell/state/testing';
import {
  activeChatAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from '@shell/state/chat/atoms';
import { openChatWithTransitionAtom } from '@shell/state/chat/actions';
import { agentRootThreadIdAtom } from '../../features/workspace/state/workspace';
import {
  chatContextChangedAtom,
  closeGitAtom,
  navigateAtom,
  openBridgeConnectionAtom,
  openBrowserAtom,
  openChatGitAtom,
  openSubAgentAtom,
  selectChatAtom,
  startNewChatAtom,
} from '@shell/navigation/actions';

const mockRouter = router as jest.Mocked<typeof router>;

function chat(id = 'old-thread', messages: Chat['messages'] = []): Chat {
  return {
    id,
    title: 'Old thread',
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    lastMessagePreview: 'Existing answer',
    messages,
  };
}

describe('router-backed navigation actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouter.canGoBack.mockReturnValue(true);
  });

  it('pushes and closes Git without replacing the mounted chat state', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });
    const hydratedChat = chat('old-thread', [
      {
        id: 'answer',
        role: 'assistant',
        content: 'Existing answer',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ]);

    store.set(chatContextChangedAtom, hydratedChat);
    store.set(openChatGitAtom, chat());

    expect(mockRouter.push).toHaveBeenCalledWith(routes.git('profile-1', hydratedChat.id));

    store.set(closeGitAtom);

    expect(mockRouter.dismissTo).toHaveBeenCalledWith(routes.chat('profile-1', hydratedChat.id));
    expect(store.get(gitChatAtom)).toBeNull();
    expect(store.get(activeChatAtom)).toBe(hydratedChat);
    expect(store.get(selectedChatIdAtom)).toBe(hydratedChat.id);
    expect(store.get(mainOpeningChatIdAtom)).toBeNull();
    expect(store.get(pendingMainChatIdAtom)).toBeNull();
    expect(store.get(pendingMainChatSnapshotAtom)).toBeNull();
  });

  it('builds canonical profile-aware URLs for drawer, chat, and sub-agent actions', () => {
    const store = createBridgeTestStore({
      api: { peekChatShell: jest.fn().mockReturnValue(null) } as unknown as HostBridgeApiClient,
    });
    store.set(chatContextChangedAtom, chat('root-thread'));

    store.set(navigateAtom, 'Settings');
    store.set(selectChatAtom, 'next-thread');
    store.set(openSubAgentAtom, 'child-thread');
    store.set(startNewChatAtom);

    expect(mockRouter.navigate).toHaveBeenCalledWith(routes.settings('profile-1'));
    expect(mockRouter.navigate).toHaveBeenCalledWith(routes.chat('profile-1', 'next-thread'));
    expect(mockRouter.push).toHaveBeenCalledWith(
      routes.agent('profile-1', 'next-thread', 'child-thread'),
    );
    expect(mockRouter.navigate).toHaveBeenCalledWith(routes.newChat('profile-1'));
    expect(mockRouter.dismissTo).not.toHaveBeenCalledWith(routes.newChat('profile-1'));
  });

  it('still navigates to a new chat when dismissTo cannot resolve the new route', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });
    mockRouter.dismissTo.mockImplementationOnce(() => {
      throw new Error('new chat is not in navigation history');
    });

    try {
      store.set(startNewChatAtom);
    } finally {
      // The direct navigation path intentionally leaves the one-shot failure queued; reset it so
      // the next test does not inherit a failure that was never consumed.
      mockRouter.dismissTo.mockReset();
    }

    expect(mockRouter.navigate).toHaveBeenCalledWith(routes.newChat('profile-1'));
  });

  it('routes starting a new chat to onboarding without a bridge profile', () => {
    const store = createTestStore();

    store.set(startNewChatAtom);

    expect(mockRouter.replace).toHaveBeenCalledWith(routes.onboarding);
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('does not let chat loading overwrite a pushed sub-agent route', () => {
    const api = {
      peekChatShell: jest.fn().mockReturnValue(null),
    } as unknown as HostBridgeApiClient;
    const store = createBridgeTestStore({ api });
    store.set(chatContextChangedAtom, chat('root-thread'));

    store.set(openChatWithTransitionAtom, 'next-thread');
    store.set(openSubAgentAtom, 'child');

    expect(mockRouter.push).toHaveBeenLastCalledWith(
      routes.agent('profile-1', 'next-thread', 'child'),
    );
  });

  it('routes guarded commands to onboarding when no bridge profile exists', () => {
    const store = createTestStore();

    store.set(navigateAtom, 'Settings');
    store.set(selectChatAtom, 'chat-1');
    store.set(openBrowserAtom, 'http://localhost:3000');
    store.set(openChatGitAtom, chat('chat-1'));
    store.set(openSubAgentAtom, 'child');
    store.set(closeGitAtom);

    expect(mockRouter.replace).toHaveBeenCalledWith(routes.onboarding);
    // replaceRoot dismisses only the route it is about to replace before landing on onboarding;
    // it must never reach for a chat-specific dismissal while there is no active profile.
    expect(mockRouter.dismissTo).toHaveBeenCalledWith(routes.onboarding);
    for (const [href] of mockRouter.dismissTo.mock.calls) {
      expect(href).toEqual(routes.onboarding);
    }
  });

  it('opens the Settings-owned connection editor with an anchored push, never dismissTo/navigate', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });
    store.set(chatContextChangedAtom, chat('root-thread'));

    store.set(openBridgeConnectionAtom);

    // A plain anchored push both adds the connection screen on top of whatever the drawer was
    // opened from (a chat, or Settings itself) and forces Settings' own `index` route to be
    // established beneath it, so it must never route through dismissTo/navigateRoot — see
    // routeNavigation.ts's dismissToThenApply for why that would risk deleting Settings' index
    // out of its own stack instead of leaving it in place.
    expect(mockRouter.push).toHaveBeenCalledWith(routes.settingsConnection('profile-1', 'edit'), {
      withAnchor: true,
    });
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('sends openBridgeConnectionAtom to onboarding when no bridge profile exists', () => {
    const store = createTestStore();

    store.set(openBridgeConnectionAtom);

    expect(mockRouter.replace).toHaveBeenCalledWith(routes.onboarding);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('dismisses a selected root agent back to its canonical chat', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });
    store.set(chatContextChangedAtom, chat('root-thread'));
    store.set(agentRootThreadIdAtom, 'root-thread');

    store.set(openSubAgentAtom, 'root-thread');

    expect(mockRouter.dismissTo).toHaveBeenCalledWith(routes.chat('profile-1', 'root-thread'));
  });
});
