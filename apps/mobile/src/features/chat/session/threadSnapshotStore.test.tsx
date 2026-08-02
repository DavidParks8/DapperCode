import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useMainScreenThreadSnapshotStore } from './threadSnapshotStore';
import type { MainScreenThreadSnapshotStoreContext } from './threadSnapshotStore';
import type { Chat } from '@bridge/types/types';

function baseChat(overrides: Partial<Chat>): Chat {
  return {
    id: 'child',
    title: 'Child thread',
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    lastMessagePreview: '',
    messages: [],
    ...overrides,
  };
}

function createContext(overrides: {
  getChat: jest.Mock;
  parentChatCache?: Record<string, Chat>;
  selectedChat: Chat | null;
  setSelectedParentChat: jest.Mock;
}): MainScreenThreadSnapshotStoreContext {
  return {
    api: { getChat: overrides.getChat },
    bridgeUiSurfacePersistenceTimeoutRef: { current: null },
    parentChatCacheRef: { current: overrides.parentChatCache ?? {} },
    persistenceController: {
      saveModelPreferences: jest.fn().mockResolvedValue(undefined),
      savePlanSnapshots: jest.fn().mockResolvedValue(undefined),
      saveBridgeUiSurfaces: jest.fn().mockResolvedValue(undefined),
    },
    runWatchdogTimerRef: { current: null },
    runWatchdogUntilRef: { current: 0 },
    selectedChat: overrides.selectedChat,
    setRunWatchdogNow: jest.fn(),
    setSelectedParentChat: overrides.setSelectedParentChat,
  } as unknown as MainScreenThreadSnapshotStoreContext;
}

function Harness({ context }: { context: MainScreenThreadSnapshotStoreContext }) {
  useMainScreenThreadSnapshotStore(context);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useMainScreenThreadSnapshotStore parent chat cache', () => {
  it('serves the stale cached parent immediately, then revalidates and reconciles a rename', async () => {
    const staleParent = baseChat({ id: 'parent', title: 'Old title' });
    const renamedParent = baseChat({ id: 'parent', title: 'New title' });
    const getChat = jest.fn().mockResolvedValue(renamedParent);
    const setSelectedParentChat = jest.fn();
    const context = createContext({
      getChat,
      parentChatCache: { parent: staleParent },
      selectedChat: baseChat({ id: 'child', parentThreadId: 'parent' }),
      setSelectedParentChat,
    });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Harness context={context} />);
    });

    // The stale cached parent is shown synchronously, without waiting on the network.
    expect(setSelectedParentChat).toHaveBeenCalledWith(staleParent);

    await flush();

    // A background revalidation still runs even though the cache already had an entry,
    // and the rename is reflected once it resolves.
    expect(getChat).toHaveBeenCalledWith('parent');
    expect(setSelectedParentChat).toHaveBeenLastCalledWith(renamedParent);
    expect(context.parentChatCacheRef.current['parent']).toEqual(renamedParent);

    act(() => tree.unmount());
  });

  it('keeps showing stale data when the background revalidation fails (deleted parent)', async () => {
    const staleParent = baseChat({ id: 'parent', title: 'Old title' });
    const getChat = jest.fn().mockRejectedValue(new Error('not found'));
    const setSelectedParentChat = jest.fn();
    const context = createContext({
      getChat,
      parentChatCache: { parent: staleParent },
      selectedChat: baseChat({ id: 'child', parentThreadId: 'parent' }),
      setSelectedParentChat,
    });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Harness context={context} />);
    });
    expect(setSelectedParentChat).toHaveBeenCalledWith(staleParent);

    await flush();

    expect(getChat).toHaveBeenCalledWith('parent');
    // The failed revalidation must not blank the still-useful stale data.
    expect(setSelectedParentChat).not.toHaveBeenCalledWith(null);
    expect(setSelectedParentChat).toHaveBeenLastCalledWith(staleParent);

    act(() => tree.unmount());
  });

  it('clears the parent when there is nothing cached and the initial fetch fails', async () => {
    const getChat = jest.fn().mockRejectedValue(new Error('not found'));
    const setSelectedParentChat = jest.fn();
    const context = createContext({
      getChat,
      parentChatCache: {},
      selectedChat: baseChat({ id: 'child', parentThreadId: 'parent' }),
      setSelectedParentChat,
    });

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<Harness context={context} />);
    });
    await flush();

    expect(getChat).toHaveBeenCalledWith('parent');
    expect(setSelectedParentChat).toHaveBeenLastCalledWith(null);

    act(() => tree.unmount());
  });
});
