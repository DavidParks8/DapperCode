import { APP_SETTINGS_VERSION, parseAppSettings } from '@shell/state/appSettings';

test('fresh settings have no preferred agent', () => {
  expect(parseAppSettings('')).toMatchObject({
    preferredAgentId: null,
    agentSettings: {},
    confirmSessionDeletion: true,
    recentModelIdsByAgent: {},
  });
});

test('persists opaque agent IDs without fixed-name migration', () => {
  const parsed = parseAppSettings(
    JSON.stringify({
      version: APP_SETTINGS_VERSION,
      preferredAgentId: 'agent-alpha',
      agentSettings: { 'agent-alpha': { collaborationMode: 'plan' } },
    }),
  );
  expect(parsed.preferredAgentId).toBe('agent-alpha');
  expect(parsed.agentSettings['agent-alpha']).toEqual({ collaborationMode: 'plan' });
});

test('rejects legacy settings versions instead of migrating obsolete agent state', () => {
  expect(
    parseAppSettings(JSON.stringify({ version: 12, preferredAgentId: 'legacy' })).preferredAgentId,
  ).toBeNull();
});

test('preserves a session deletion confirmation opt-out and safely defaults invalid values', () => {
  expect(
    parseAppSettings(
      JSON.stringify({ version: APP_SETTINGS_VERSION, confirmSessionDeletion: false }),
    ).confirmSessionDeletion,
  ).toBe(false);
  expect(
    parseAppSettings(
      JSON.stringify({ version: APP_SETTINGS_VERSION, confirmSessionDeletion: 'no' }),
    ).confirmSessionDeletion,
  ).toBe(true);
});

test('normalizes and caps recent model IDs per agent', () => {
  const parsed = parseAppSettings(
    JSON.stringify({
      version: APP_SETTINGS_VERSION,
      recentModelIdsByAgent: {
        ' codex ': ['gpt-c', ' gpt-b ', 'gpt-c', 'gpt-a', 'gpt-d'],
        empty: [],
        invalid: 'gpt-z',
      },
    }),
  );

  expect(parsed.recentModelIdsByAgent).toEqual({
    codex: ['gpt-c', 'gpt-b', 'gpt-a'],
  });
});
