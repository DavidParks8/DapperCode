import type { ReactNode } from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { Redirect, useLocalSearchParams } from 'expo-router';
import ChatIndexRoute from '../../app/profiles/[profileId]/(drawer)/chats/[chatId]';
import { MainScreen } from '../../features/chat/screen/MainScreen';
import { createTestStore, withAppStore } from '../state/testing';
import { chatSnapshotCacheAtom, interruptedChatCreationAtom } from '../state/chat/atoms';
import {
  createEmptyChatSnapshotCache,
  updateChatSnapshotCache,
} from '../session/chatSnapshotCache';
import { routes } from './routes';

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(),
  Redirect: jest.fn(() => null),
}));
jest.mock('./usePromoteNewChatRoute', () => ({ usePromoteNewChatRoute: jest.fn() }));
jest.mock('./ProfileRouteBoundary', () => ({
  useProfileRouteReady: () => true,
  ProfileRouteContent: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('../../features/chat/screen/MainScreen', () => ({ MainScreen: jest.fn(() => null) }));

it('recovers a stale pending URL before mounting any remote chat controller', async () => {
  jest.mocked(useLocalSearchParams).mockReturnValue({
    profileId: 'profile',
    chatId: 'pending-original',
  });

  const store = createTestStore();
  const at = new Date().toISOString();
  const cache = updateChatSnapshotCache(
    createEmptyChatSnapshotCache('profile'),
    'pending-original',
    {
      id: 'pending-original',
      title: '',
      status: 'running',
      createdAt: at,
      updatedAt: at,
      statusUpdatedAt: at,
      lastMessagePreview: 'Unsent',
      messages: [{ id: 'msg-original', role: 'user', content: 'Unsent', createdAt: at }],
    },
  );
  store.set(chatSnapshotCacheAtom, cache);
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(withAppStore(store, <ChatIndexRoute />));
  });
  expect(MainScreen).not.toHaveBeenCalled();
  expect(store.get(interruptedChatCreationAtom)?.draft).toBe('Unsent');
  expect(tree?.root.findByType(Redirect).props['href']).toEqual(routes.newChat('profile'));
  act(() => tree?.unmount());
});

it('does not let an obsolete pending URL replace the selected recovery', async () => {
  jest.mocked(useLocalSearchParams).mockReturnValue({
    profileId: 'profile',
    chatId: 'pending-old',
  });
  const store = createTestStore();
  const at = new Date().toISOString();
  const pending = (id: string, content: string) => ({
    id,
    title: '',
    status: 'running' as const,
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: content,
    messages: [{ id: `msg-${id}`, role: 'user' as const, content, createdAt: at }],
  });
  let cache = updateChatSnapshotCache(
    createEmptyChatSnapshotCache('profile'),
    'pending-old',
    pending('pending-old', 'Old'),
  );
  cache = updateChatSnapshotCache(cache, 'pending-new', pending('pending-new', 'New'));
  store.set(chatSnapshotCacheAtom, cache);
  store.set(interruptedChatCreationAtom, {
    submissionId: 'new',
    pendingChatId: 'pending-new',
    draft: 'New',
    cwd: undefined,
    agentId: undefined,
    hadAttachments: false,
  });
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(withAppStore(store, <ChatIndexRoute />));
  });
  expect(MainScreen).not.toHaveBeenCalled();
  expect(store.get(interruptedChatCreationAtom)?.pendingChatId).toBe('pending-new');
  expect(tree?.root.findByType(Redirect).props['href']).toEqual(routes.newChat('profile'));
  act(() => tree?.unmount());
});

it('routes a durably linked pending URL to its real created thread', async () => {
  jest.mocked(useLocalSearchParams).mockReturnValue({
    profileId: 'profile',
    chatId: 'pending-linked',
  });
  const store = createTestStore();
  const at = new Date().toISOString();
  const cache = updateChatSnapshotCache(createEmptyChatSnapshotCache('profile'), 'pending-linked', {
    id: 'pending-linked',
    title: '',
    status: 'running',
    createdAt: at,
    updatedAt: at,
    statusUpdatedAt: at,
    lastMessagePreview: 'Retry',
    localPendingCreation: {
      draft: 'Retry',
      hadAttachments: false,
      agentId: 'agent',
      cwd: '/workspace',
      createdChatId: 'thread-created',
    },
    messages: [{ id: 'msg-linked', role: 'user', content: 'Retry', createdAt: at }],
  });
  store.set(chatSnapshotCacheAtom, cache);
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(withAppStore(store, <ChatIndexRoute />));
  });
  expect(MainScreen).not.toHaveBeenCalled();
  expect(store.get(interruptedChatCreationAtom)?.createdChatId).toBe('thread-created');
  expect(tree?.root.findByType(Redirect).props['href']).toEqual(
    routes.chat('profile', 'thread-created'),
  );
  act(() => tree?.unmount());
});
