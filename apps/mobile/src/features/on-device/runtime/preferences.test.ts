import { emptyLocalPreferences, parseLocalPreferences } from './preferences';

test('only absent preferences produce defaults; invalid stored data is never reset', () => {
  expect(parseLocalPreferences(null)).toEqual(emptyLocalPreferences());
  for (const raw of [
    '{',
    'null',
    '{}',
    '{"version":2}',
    JSON.stringify({ ...emptyLocalPreferences(), drafts: { a: 3 } }),
  ]) {
    expect(() => parseLocalPreferences(raw)).toThrow();
  }
});

test('preferences round-trip drafts, workspace, model, opaque account reference, and offline author', () => {
  const preferences = {
    ...emptyLocalPreferences(),
    workspaceId: 'local-workspace',
    modelId: 'qwen3-1.7b-q4-k-m',
    drafts: { '00000000-0000-4000-8000-000000000001': 'unfinished draft' },
    author: { name: 'Offline Author', email: 'author@example.invalid' },
    account: {
      providerId: 'github',
      host: 'github.com',
      id: '123',
      login: 'author',
      credentialRef: 'opaque-ref',
    },
  };
  expect(parseLocalPreferences(JSON.stringify(preferences))).toEqual(preferences);
  expect(JSON.stringify(preferences)).not.toContain('access_token');
  expect(() =>
    parseLocalPreferences(
      JSON.stringify({
        ...preferences,
        account: { ...preferences.account, host: 'other.example' },
      }),
    ),
  ).toThrow('account');
});

const storedAccount = {
  providerId: 'github',
  host: 'github.com',
  id: '123',
  login: 'author',
  credentialRef: 'opaque-ref',
};

test.each([
  [{ workspaceId: 123 }, 'preference text'],
  [{ modelId: '' }, 'preference text'],
  [{ account: [] }, 'account data is invalid'],
  [{ account: { ...storedAccount, providerId: 'unsupported' } }, 'account data is invalid'],
  [{ account: { ...storedAccount, id: null } }, 'account data is incomplete'],
  [{ account: { ...storedAccount, login: null } }, 'account data is incomplete'],
  [{ account: { ...storedAccount, credentialRef: null } }, 'account data is incomplete'],
  [{ author: [] }, 'author data is invalid'],
  [{ author: { name: 123, email: 'author@example.invalid' } }, 'author data is invalid'],
  [{ author: { name: 'Author', email: 123 } }, 'author data is invalid'],
])(
  'rejects malformed saved preferences without returning replacement defaults: %j',
  (patch, message) => {
    const raw = JSON.stringify({ ...emptyLocalPreferences(), ...patch });
    expect(() => parseLocalPreferences(raw)).toThrow(message);
  },
);
