import { parsePairingPayload } from './pairing';

describe('broker pairing payloads', () => {
  it('preserves the workspace route from the desktop broker QR payload', () => {
    expect(
      parsePairingPayload(
        JSON.stringify({
          type: 'dappercode-broker-pair',
          brokerProtocolVersion: 1,
          workspaceId: 'workspace-alpha-000000000001',
          bridgeUrl: 'http://100.64.0.10:8787',
          bridgeToken: 'workspace-token',
        }),
      ),
    ).toEqual({
      workspaceId: 'workspace-alpha-000000000001',
      bridgeUrl: 'http://100.64.0.10:8787',
      bridgeToken: 'workspace-token',
    });
  });

  it('keeps legacy pairing payloads routable by token and rejects unsafe workspace ids', () => {
    expect(
      parsePairingPayload(
        JSON.stringify({
          type: 'dappercode-bridge-pair',
          bridgeUrl: 'http://127.0.0.1:8787',
          bridgeToken: 'legacy-token',
        }),
      ),
    ).toEqual({
      bridgeUrl: 'http://127.0.0.1:8787',
      bridgeToken: 'legacy-token',
    });
    expect(
      parsePairingPayload(
        'dappercode://pair?bridgeUrl=http%3A%2F%2F127.0.0.1%3A8787&token=token&workspaceId=..%2Fother',
      ),
    ).toEqual({
      bridgeUrl: 'http://127.0.0.1:8787',
      bridgeToken: 'token',
    });
  });
});
