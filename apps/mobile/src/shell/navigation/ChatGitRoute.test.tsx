jest.mock('../../features/git/GitScreen', () => ({
  GitScreen: ({ chat }: { chat: { id: string } }) => `Git:${chat.id}`,
}));
jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import type { HostBridgeApiClient } from '@bridge/client/client';
import type { Chat } from '@bridge/types/types';
import { createBridgeTestStore, withAppStore } from '@shell/state/testing';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import { ChatGitRoute } from '@shell/navigation/ChatGitRoute';

const chat: Chat = {
  id: 'chat-1',
  title: 'Chat',
  status: 'complete',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  statusUpdatedAt: '2026-01-01T00:00:00.000Z',
  lastMessagePreview: '',
  messages: [],
};

function renderRoute(api: HostBridgeApiClient): ReactTestRenderer {
  const store = createBridgeTestStore({ api });
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      withAppStore(
        store,
        <AppThemeProvider theme={createAppTheme('dark')}>
          <ChatGitRoute chatId={chat.id} />
        </AppThemeProvider>,
      ),
    );
  });
  if (!tree) {
    throw new Error('Expected Git route');
  }
  return tree;
}

function jsonOf(tree: ReactTestRenderer): string {
  return JSON.stringify((tree as unknown as { toJSON: () => unknown }).toJSON());
}

describe('ChatGitRoute', () => {
  it('renders an immediately cached chat', () => {
    const api = {
      peekChat: jest.fn(() => chat),
      peekChatShell: jest.fn(),
    } as unknown as HostBridgeApiClient;
    const tree = renderRoute(api);
    expect(jsonOf(tree)).toContain('Git:chat-1');
    act(() => tree.unmount());
  });

  it('loads a cold deep-linked chat before rendering Git', async () => {
    const api = {
      peekChat: jest.fn(),
      peekChatShell: jest.fn(),
      getChat: jest.fn().mockResolvedValue(chat),
    } as unknown as HostBridgeApiClient;
    const tree = renderRoute(api);
    expect(jsonOf(tree)).toContain('Loading Git chat');
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.getChat).toHaveBeenCalledWith(chat.id);
    expect(jsonOf(tree)).toContain('Git:chat-1');
    act(() => tree.unmount());
  });

  it('surfaces an explicit recovery state when the chat cannot load', async () => {
    const api = {
      peekChat: jest.fn(),
      peekChatShell: jest.fn(),
      getChat: jest.fn().mockRejectedValue(new Error('missing chat')),
    } as unknown as HostBridgeApiClient;
    const tree = renderRoute(api);
    await act(async () => {
      await Promise.resolve();
    });
    expect(jsonOf(tree)).toContain('Could not open Git');
    expect(jsonOf(tree)).toContain('missing chat');
    act(() => tree.unmount());
  });
});
