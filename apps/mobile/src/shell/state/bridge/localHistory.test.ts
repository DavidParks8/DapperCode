import { createDefaultAppStateData } from '@shell/state/appState';
import { LocalBridgeServer } from '../../../features/on-device/transport/server';
import { FakeAgentPort } from '../../../features/on-device/transport/testing';
import { LOCAL_WORKSPACE_ROOT } from '../../../features/on-device/transport/wire';
import { LocalBridgeWsClient } from '@shell/runtime/LocalBridgeWsClient';
import { apiClientAtom, localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { localTransportAtom } from '@shell/state/local/atoms';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { createTestStore } from '@shell/state/testing';
import { resolveEquivalentChat } from '../../../features/chat/state/chatReconciliation';

const DEMO = `${LOCAL_WORKSPACE_ROOT}/Demo`;

describe('On this iPhone chat history after a crash', () => {
  it('shows the recovered runtime conversation, not a cached reply the runtime never stored', async () => {
    const data = createDefaultAppStateData();
    data.bridgeProfiles = { activeProfileId: LOCAL_PROFILE_ID, profiles: [] };
    const store = createTestStore({ data });
    store.set(localProfileAvailableAtom, true);
    const port = new FakeAgentPort();
    const transport = new LocalBridgeWsClient(new LocalBridgeServer(port));
    transport.connect();
    store.set(localTransportAtom, transport);
    const api = store.get(apiClientAtom)!;
    expect(api.profileId).toBe(LOCAL_PROFILE_ID);

    const created = await api.createChatIdempotent({ cwd: DEMO }, 'create');
    let turnId = '';
    await api.sendChatMessageIdempotent(created.id, { content: 'Commit it', cwd: DEMO }, 'send', {
      onTurnStarted: (id) => (turnId = id),
    });
    const completion = transport.waitForTurnCompletion(created.id, turnId, 1_000);
    port.streamAssistant(created.id, 'reply', 'Committed abc123');
    port.settle(created.id, 'complete');
    await completion;
    const shown = await api.getChat(created.id, { forceRefresh: true });
    expect(shown.messages.map(({ content }) => content)).toEqual(['Commit it', 'Committed abc123']);

    // The app was killed after the reply streamed but before its coalesced write: the relaunched
    // runtime has only the journaled user turn and marks the run interrupted.
    const stored = port.threadMap.get(created.id)!;
    port.threadMap.set(created.id, {
      ...stored,
      status: 'interrupted',
      messages: stored.messages.slice(0, 1),
    });

    const recovered = await api.getChat(created.id, { forceRefresh: true });
    expect(recovered.historyRecoveryError).toBeNull();
    expect(recovered.messages.map(({ content }) => content)).toEqual(['Commit it']);
    const onScreen = resolveEquivalentChat(shown, recovered);
    expect(onScreen.messages.map(({ content }) => content)).toEqual(['Commit it']);
    transport.dispose();
  });
});
