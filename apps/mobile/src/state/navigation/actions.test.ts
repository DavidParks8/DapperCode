import type { HostBridgeApiClient } from '../../api/client';
import type { Chat } from '../../api/types';
import { createBridgeTestStore } from '../testing';
import {
  activeChatAtom,
  chatTransitionChatIdAtom,
  gitChatAtom,
  mainOpeningChatIdAtom,
  pendingMainChatIdAtom,
  pendingMainChatSnapshotAtom,
  selectedChatIdAtom,
} from '../chat/atoms';
import { openChatWithTransitionAtom } from '../chat/actions';
import {
  chatContextChangedAtom,
  closeGitAtom,
  openChatGitAtom,
  openSubAgentAtom,
} from './actions';
import {
  currentNavigationRouteAtom,
  currentScreenAtom,
  navigationCanGoBackAtom,
  navigationStackAtom,
  popNavigationRouteAtom,
  pushNavigationRouteAtom,
} from './atoms';

function chat(messages: Chat['messages']): Chat {
  return {
    id: 'old-thread',
    title: 'Old thread',
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    lastMessagePreview: 'Existing answer',
    messages,
  };
}

describe('navigation actions', () => {
  it('pops Git without re-opening or replacing the mounted chat', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });
    const hydratedChat = chat([
      {
        id: 'answer',
        role: 'assistant',
        content: 'Existing answer',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
    ]);
    const gitChatShell = chat([]);

    store.set(chatContextChangedAtom, hydratedChat);
    store.set(openChatGitAtom, gitChatShell);
    expect(store.get(currentScreenAtom)).toBe('ChatGit');
    expect(store.get(navigationStackAtom)).toEqual([{ screen: 'Main' }, { screen: 'ChatGit' }]);

    store.set(closeGitAtom);

    expect(store.get(currentScreenAtom)).toBe('Main');
    expect(store.get(navigationStackAtom)).toEqual([{ screen: 'Main' }]);
    expect(store.get(gitChatAtom)).toBeNull();
    expect(store.get(activeChatAtom)).toBe(hydratedChat);
    expect(store.get(selectedChatIdAtom)).toBe(hydratedChat.id);
    expect(store.get(chatTransitionChatIdAtom)).toBeNull();
    expect(store.get(mainOpeningChatIdAtom)).toBeNull();
    expect(store.get(pendingMainChatIdAtom)).toBeNull();
    expect(store.get(pendingMainChatSnapshotAtom)).toBeNull();
  });

  it('pushes and pops sub-agent routes through the app navigation stack', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });

    store.set(pushNavigationRouteAtom, { screen: 'SubAgent', threadId: 'child' });
    store.set(pushNavigationRouteAtom, { screen: 'SubAgent', threadId: 'grandchild' });

    expect(store.get(currentScreenAtom)).toBe('SubAgent');
    expect(store.get(currentNavigationRouteAtom)).toEqual({
      screen: 'SubAgent',
      threadId: 'grandchild',
    });
    expect(store.get(navigationCanGoBackAtom)).toBe(true);
    expect(store.get(navigationStackAtom)).toEqual([
      { screen: 'Main' },
      { screen: 'SubAgent', threadId: 'child' },
      { screen: 'SubAgent', threadId: 'grandchild' },
    ]);

    store.set(popNavigationRouteAtom);
    expect(store.get(currentNavigationRouteAtom)).toEqual({
      screen: 'SubAgent',
      threadId: 'child',
    });

    store.set(popNavigationRouteAtom);
    store.set(popNavigationRouteAtom);
    expect(store.get(navigationStackAtom)).toEqual([{ screen: 'Main' }]);
    expect(store.get(navigationCanGoBackAtom)).toBe(false);
  });

  it('keeps a sub-agent route open when a delayed chat transition settles', async () => {
    jest.useFakeTimers();
    try {
      const api = {
        peekChatShell: jest.fn().mockReturnValue(null),
      } as unknown as HostBridgeApiClient;
      const store = createBridgeTestStore({ api });

      const pendingTransition = store.set(openChatWithTransitionAtom, 'next-thread');
      expect(store.get(chatTransitionChatIdAtom)).toBe('next-thread');

      store.set(openSubAgentAtom, 'child');
      jest.runAllTimers();
      await pendingTransition;

      expect(store.get(currentNavigationRouteAtom)).toEqual({
        screen: 'SubAgent',
        threadId: 'child',
      });
      expect(store.get(chatTransitionChatIdAtom)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('resets parameterless screens to their canonical stack', () => {
    const store = createBridgeTestStore({ api: {} as HostBridgeApiClient });

    store.set(currentScreenAtom, 'Privacy');
    expect(store.get(navigationStackAtom)).toEqual([
      { screen: 'Main' },
      { screen: 'Settings' },
      { screen: 'Privacy' },
    ]);

    store.set(currentScreenAtom, 'Main');
    expect(store.get(navigationStackAtom)).toEqual([{ screen: 'Main' }]);
  });
});
