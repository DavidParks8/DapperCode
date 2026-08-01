import { router } from 'expo-router';
jest.mock('expo-router', () => jest.requireActual('../testing/expoRouterMock'));

import type { HostBridgeApiClient } from '../api/client';
import type { Chat } from '../api/types';
import { routes } from './routes';
import { createBridgeTestStore, createTestStore } from '../state/testing';
import {
  activeChatAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from '../state/chat/atoms';
import { openChatWithTransitionAtom } from '../state/chat/actions';
import { agentRootThreadIdAtom } from '../state/mainScreen/workspace';
import {
  chatContextChangedAtom,
  closeGitAtom,
  navigateAtom,
  openBrowserAtom,
  openChatGitAtom,
  openSubAgentAtom,
  selectChatAtom,
  startNewChatAtom,
} from './actions';

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
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
  });

  it('dismisses a selected root agent back to its canonical chat', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });
    store.set(chatContextChangedAtom, chat('root-thread'));
    store.set(agentRootThreadIdAtom, 'root-thread');

    store.set(openSubAgentAtom, 'root-thread');

    expect(mockRouter.dismissTo).toHaveBeenCalledWith(routes.chat('profile-1', 'root-thread'));
  });
});
