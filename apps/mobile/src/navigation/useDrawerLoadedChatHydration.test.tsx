import renderer, { act } from 'react-test-renderer';
import { useDrawerLoadedChatHydration } from './useDrawerLoadedChatHydration';
import type { ChatSummary } from '../api/types';

function summary(id: string): ChatSummary {
  return {
    id,
    title: id,
    status: 'complete',
    createdAt: '',
    updatedAt: '',
    statusUpdatedAt: '',
    lastMessagePreview: '',
  };
}

function Harness({
  api,
  applyChats,
  setDiagnostics,
  hydrateRef,
}: {
  api: { listLoadedChatIds: jest.Mock; getChatSummaries: jest.Mock };
  applyChats: jest.Mock;
  setDiagnostics: jest.Mock;
  hydrateRef: { current: ReturnType<typeof useDrawerLoadedChatHydration> | null };
}) {
  hydrateRef.current = useDrawerLoadedChatHydration({
    activeRef: { current: true },
    api: api as never,
    applyChats,
    setDiagnostics,
  });
  return null;
}

describe('useDrawerLoadedChatHydration', () => {
  it('dedupes repeated loaded-chat ids so hydration does not redundantly re-fetch the same chat', async () => {
    // Regression: a bridge response with duplicate loaded ids must not grow the
    // missing-id list and cause repeated/redundant summary fetch-and-apply work.
    const listedChats = [summary('listed')];
    const api = {
      listLoadedChatIds: jest.fn().mockResolvedValue(['missing', 'missing', 'listed']),
      getChatSummaries: jest.fn().mockResolvedValue([summary('missing')]),
    };
    const applyChats = jest.fn();
    const setDiagnostics = jest.fn();
    const hydrateRef: { current: ReturnType<typeof useDrawerLoadedChatHydration> | null } = {
      current: null,
    };

    await act(async () => {
      renderer.create(
        <Harness api={api} applyChats={applyChats} setDiagnostics={setDiagnostics} hydrateRef={hydrateRef} />,
      );
    });

    await act(async () => {
      await hydrateRef.current?.(listedChats);
    });

    expect(api.getChatSummaries).toHaveBeenCalledTimes(1);
    expect(api.getChatSummaries).toHaveBeenCalledWith(['missing']);
    expect(applyChats).toHaveBeenCalledTimes(1);
  });
});
