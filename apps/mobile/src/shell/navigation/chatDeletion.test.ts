import type { ChatSummary } from '@bridge/types/types';
import {
  buildBulkDeletionPlan,
  buildChatDeletionFamily,
  deleteChatFamilies,
  deleteChatFamily,
  restoreChatFamilies,
  type ChatDeletionApi,
} from '@shell/navigation/chatDeletion';

function createChat(id: string, parentThreadId?: string): ChatSummary {
  return {
    id,
    title: `Chat ${id}`,
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    cwd: '/workspace',
    lastMessagePreview: '',
    ...(parentThreadId ? { parentThreadId } : null),
  };
}

function createApi(overrides: Partial<ChatDeletionApi> = {}): {
  api: ChatDeletionApi;
  deleteChat: jest.Mock;
  forgetChat: jest.Mock;
} {
  const deleteChat = jest.fn(async () => undefined);
  const forgetChat = jest.fn();
  const api = { deleteChat, forgetChat, ...overrides };
  return { api, deleteChat: api.deleteChat as jest.Mock, forgetChat: api.forgetChat as jest.Mock };
}

describe('chatDeletion service', () => {
  it('collects the whole sub-tree under a root', () => {
    const chats = [
      createChat('root'),
      createChat('child', 'root'),
      createChat('grandchild', 'child'),
      createChat('unrelated'),
    ];

    const family = buildChatDeletionFamily(chats, 'root');

    expect(family.rootId).toBe('root');
    expect(Array.from(family.chatIds).sort()).toEqual(['child', 'grandchild', 'root']);
    expect(family.chats.map((chat) => chat.id)).toEqual(['root', 'child', 'grandchild']);
  });

  it('still targets a root that is no longer in the loaded list', () => {
    const family = buildChatDeletionFamily([createChat('other')], 'missing');

    expect(family.chats).toEqual([]);
    expect(Array.from(family.chatIds)).toEqual(['missing']);
  });

  it('drops selected descendants whose selected ancestor already removes them', () => {
    const chats = [createChat('root'), createChat('child', 'root'), createChat('solo')];

    const { families, affectedChatIds } = buildBulkDeletionPlan(
      chats,
      new Set(['root', 'child', 'solo']),
    );

    expect(families.map((family) => family.rootId)).toEqual(['root', 'solo']);
    expect(Array.from(affectedChatIds).sort()).toEqual(['child', 'root', 'solo']);
  });

  it('deletes only the root on the bridge and forgets its descendants locally', async () => {
    const { api, deleteChat, forgetChat } = createApi();
    const family = buildChatDeletionFamily(
      [createChat('root'), createChat('child', 'root')],
      'root',
    );

    const deleted = await deleteChatFamily(api, family);

    expect(deleteChat).toHaveBeenCalledTimes(1);
    expect(deleteChat).toHaveBeenCalledWith('root');
    expect(forgetChat.mock.calls).toEqual([['child']]);
    expect(Array.from(deleted ?? []).sort()).toEqual(['child', 'root']);
  });

  it('reports a refusal without forgetting anything', async () => {
    const { api, forgetChat } = createApi({
      deleteChat: jest.fn(async () => {
        throw new Error('offline');
      }) as unknown as ChatDeletionApi['deleteChat'],
    });
    const family = buildChatDeletionFamily(
      [createChat('root'), createChat('child', 'root')],
      'root',
    );

    await expect(deleteChatFamily(api, family)).resolves.toBeNull();
    expect(forgetChat).not.toHaveBeenCalled();
  });

  it('keeps deleting after one family is refused', async () => {
    const { api, deleteChat } = createApi({
      deleteChat: jest.fn(async (chatId: string) => {
        if (chatId === 'b') {
          throw new Error('offline');
        }
      }) as unknown as ChatDeletionApi['deleteChat'],
    });
    const chats = [createChat('a'), createChat('b'), createChat('c')];
    const families = ['a', 'b', 'c'].map((id) => buildChatDeletionFamily(chats, id));

    const { failedFamilies, deletedChatIds } = await deleteChatFamilies(api, families);

    expect(deleteChat).toHaveBeenCalledTimes(3);
    expect(failedFamilies.map((family) => family.rootId)).toEqual(['b']);
    expect(Array.from(deletedChatIds).sort()).toEqual(['a', 'c']);
  });

  it('restores every known row of the failed families', () => {
    const chats = [createChat('root'), createChat('child', 'root')];
    const family = buildChatDeletionFamily(chats, 'root');
    const restoreChat = jest.fn();

    const restoredChatIds = restoreChatFamilies([family], restoreChat);

    expect(restoreChat.mock.calls.map(([chat]: [ChatSummary]) => chat.id)).toEqual([
      'root',
      'child',
    ]);
    expect(Array.from(restoredChatIds).sort()).toEqual(['child', 'root']);
  });
});
