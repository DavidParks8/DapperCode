import {
  createEmptyBridgeProfileStore,
  deriveBridgeProfileName,
  getActiveBridgeProfile,
  parseBridgeProfileStore,
  setActiveBridgeProfile,
  upsertBridgeProfile,
} from '@shell/state/bridgeProfiles';

describe('bridgeProfiles', () => {
  it('derives a profile name from the bridge hostname when omitted', () => {
    expect(deriveBridgeProfileName(null, 'http://192.168.1.39:8787')).toBe('192.168.1.39');
  });

  it('upserts and activates profiles', () => {
    const empty = createEmptyBridgeProfileStore();
    const created = upsertBridgeProfile(empty, {
      name: 'Office Mac',
      bridgeUrl: 'http://192.168.1.39:8787',
      bridgeToken: 'secret-one',
      activate: true,
    }).store;

    expect(created.profiles).toHaveLength(1);
    expect(created.activeProfileId).toBe(created.profiles[0]?.id);

    const updated = upsertBridgeProfile(created, {
      id: created.profiles[0]?.id,
      name: 'Office Mac Mini',
      bridgeUrl: 'http://192.168.1.39:8787',
      bridgeToken: 'secret-two',
      activate: true,
    }).store;

    expect(updated.profiles).toHaveLength(1);
    expect(updated.profiles[0]?.name).toBe('Office Mac Mini');
    expect(updated.profiles[0]?.bridgeToken).toBe('secret-two');
  });

  it('migrates legacy entries without a workspace id and preserves routed broker entries', () => {
    const parsed = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'legacy',
        profiles: [
          {
            id: 'legacy',
            bridgeUrl: 'http://bridge:8787',
            bridgeToken: 'legacy-token',
          },
          {
            id: 'broker',
            bridgeUrl: 'http://bridge:8787',
            bridgeToken: 'broker-token',
            workspaceId: 'workspace-alpha-000000000001',
          },
        ],
      }),
    );

    expect(parsed.profiles[0]?.workspaceId).toBeNull();
    expect(parsed.profiles[1]?.workspaceId).toBe('workspace-alpha-000000000001');

    const cleared = upsertBridgeProfile(parsed, {
      id: 'broker',
      bridgeUrl: 'http://bridge:8787',
      bridgeToken: 'broker-token',
      workspaceId: null,
    }).store;
    expect(cleared.profiles.find((profile) => profile.id === 'broker')?.workspaceId).toBeNull();
  });

  it('parses stores and drops invalid active ids', () => {
    const parsed = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'missing',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
        ],
      }),
    );

    expect(parsed.activeProfileId).toBeNull();
    expect(parsed.profiles).toHaveLength(1);
  });

  it('changes the active profile without altering saved entries', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'profile-1',
        profiles: [
          {
            id: 'profile-1',
            name: 'Server A',
            bridgeUrl: 'http://10.0.0.1:8787',
            bridgeToken: 'token-a',
          },
          {
            id: 'profile-2',
            name: 'Server B',
            bridgeUrl: 'http://10.0.0.2:8787',
            bridgeToken: 'token-b',
          },
        ],
      }),
    );

    const switched = setActiveBridgeProfile(base, 'profile-2');

    expect(switched.activeProfileId).toBe('profile-2');
    expect(switched.profiles).toHaveLength(2);
  });

  it('returns empty stores for missing, malformed, and non-object data', () => {
    expect(parseBridgeProfileStore(null)).toEqual(createEmptyBridgeProfileStore());
    expect(parseBridgeProfileStore('   ')).toEqual(createEmptyBridgeProfileStore());
    expect(parseBridgeProfileStore('{')).toEqual(createEmptyBridgeProfileStore());
    expect(parseBridgeProfileStore('null')).toEqual(createEmptyBridgeProfileStore());
    expect(parseBridgeProfileStore(JSON.stringify({ profiles: 'invalid' }))).toEqual(
      createEmptyBridgeProfileStore(),
    );
  });

  it('drops malformed profiles and normalizes valid profile fields', () => {
    const parsed = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 1,
        profiles: [
          null,
          {},
          { id: 'x', bridgeUrl: 1, bridgeToken: 'token' },
          { id: 'x', bridgeUrl: 'ftp://host', bridgeToken: 'token' },
          { id: 'x', bridgeUrl: 'http://host', bridgeToken: ' ' },
          {
            id: ' valid ',
            name: ' ',
            bridgeUrl: 'ws://host:8787/',
            bridgeToken: ' token ',
            createdAt: ' ',
            updatedAt: 1,
          },
        ],
      }),
    );
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]).toMatchObject({
      id: 'valid',
      name: 'host',
      bridgeUrl: 'http://host:8787',
      bridgeToken: 'token',
    });
  });

  it('rejects incomplete drafts and honors activation choices', () => {
    const empty = createEmptyBridgeProfileStore();
    expect(() => upsertBridgeProfile(empty, { bridgeUrl: '', bridgeToken: 'token' })).toThrow();
    expect(() =>
      upsertBridgeProfile(empty, { bridgeUrl: 'http://host', bridgeToken: ' ' }),
    ).toThrow();
    const first = upsertBridgeProfile(empty, {
      bridgeUrl: 'http://one',
      bridgeToken: 'one',
      activate: true,
    }).store;
    const second = upsertBridgeProfile(first, {
      bridgeUrl: 'http://two',
      bridgeToken: 'two',
      activate: false,
    }).store;
    expect(second.activeProfileId).toBe(first.activeProfileId);
    expect(second.profiles).toHaveLength(2);
  });

  it('sanitizes missing profile operations and active lookup', () => {
    const base = parseBridgeProfileStore(
      JSON.stringify({
        activeProfileId: 'one',
        profiles: [{ id: 'one', bridgeUrl: 'http://one', bridgeToken: 'token' }],
      }),
    );
    expect(getActiveBridgeProfile(base)?.id).toBe('one');
    expect(getActiveBridgeProfile({ ...base, activeProfileId: null })).toBeNull();
    expect(getActiveBridgeProfile({ ...base, activeProfileId: 'missing' })).toBeNull();
    expect(setActiveBridgeProfile(base, null).activeProfileId).toBeNull();
    expect(setActiveBridgeProfile(base, 'missing').activeProfileId).toBe('one');
  });

  it('derives safe fallback names', () => {
    expect(deriveBridgeProfileName(' Name ', 'not-used')).toBe('Name');
    expect(deriveBridgeProfileName(null, 'not a url')).toBe('Bridge');
  });
});
