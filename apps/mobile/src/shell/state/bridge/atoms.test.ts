const mockWsConstructor = jest.fn();

jest.mock('@bridge/ws/ws', () => ({
  HostBridgeWsClient: class {
    constructor(baseUrl: string, options: unknown) {
      mockWsConstructor(baseUrl, options);
    }
  },
}));

import { createDefaultAppStateData } from '@shell/state/appState';
import { wsClientAtom } from '@shell/state/bridge/atoms';
import { createTestStore } from '@shell/state/testing';

describe('bridge client atoms', () => {
  it('identifies the primary bridge socket as a mobile client', () => {
    const data = createDefaultAppStateData();
    data.bridgeProfiles = {
      activeProfileId: 'profile-1',
      profiles: [
        {
          id: 'profile-1',
          name: 'Bridge',
          bridgeUrl: 'https://bridge.example',
          bridgeToken: 'token',
          workspaceId: 'workspace-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    const store = createTestStore({ data });

    expect(store.get(wsClientAtom)).not.toBeNull();
    expect(mockWsConstructor).toHaveBeenCalledWith(
      'https://bridge.example',
      expect.objectContaining({
        workspaceId: 'workspace-1',
        clientType: 'mobile',
        clientName: 'DapperCode Mobile',
        getClientForeground: expect.any(Function),
      }),
    );
  });
});
