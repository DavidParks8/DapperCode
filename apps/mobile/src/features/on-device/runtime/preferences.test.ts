import {
  emptyLocalPreferences,
  LocalPreferencesStore,
  PREFERENCES_DOCUMENT,
  parseLocalPreferences,
  parseStoredLocalPreferences,
  serializeLocalPreferences,
} from './preferences';

async function preferenceStore() {
  const documents = new Map([
    [
      PREFERENCES_DOCUMENT,
      serializeLocalPreferences({
        ...emptyLocalPreferences(),
        modelId: 'model-a',
        workspaceId: 'workspace-one',
      }),
    ],
  ]);
  const storage = {
    readRuntimeDocument: jest.fn(async (name: string) => documents.get(name) ?? null),
    writeRuntimeDocument: jest.fn(async (name: string, contents: string) => {
      documents.set(name, contents);
    }),
    listRuntimeDocuments: jest.fn(async (prefix: string) =>
      [...documents.keys()].filter((name) => name.startsWith(prefix)),
    ),
    removeRuntimeDocument: jest.fn(async (name: string) => {
      documents.delete(name);
    }),
  };
  const store = new LocalPreferencesStore(storage, jest.fn());
  await store.restore();
  return { store, storage, documents };
}

describe('durable preferences queue', () => {
  it.each([false, true])(
    'preserves the confirmed model through a concurrent workspace save (choice succeeds %s)',
    async (succeeds) => {
      const h = await preferenceStore();
      const write = h.storage.writeRuntimeDocument.getMockImplementation()!;
      let started!: () => void;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      let resolveWrite!: () => void;
      let rejectWrite!: (error: Error) => void;
      h.storage.writeRuntimeDocument.mockImplementationOnce(async (name, contents) => {
        started();
        await new Promise<void>((resolve, reject) => {
          resolveWrite = resolve;
          rejectWrite = reject;
        });
        await write(name, contents);
      });
      const choosing = h.store.chooseModel('model-b');
      const outcome = choosing.then(
        () => null,
        (error: unknown) => error,
      );
      await writing;
      h.store.update({ workspaceId: 'workspace-two' });
      const saving = h.store.save();
      if (succeeds) {
        resolveWrite();
      } else {
        rejectWrite(new Error('Model preference write failed.'));
      }
      const error = await outcome;
      expect(error instanceof Error).toBe(!succeeds);
      await saving;
      const expected = succeeds ? 'model-b' : 'model-a';
      expect(h.store.get()).toMatchObject({ modelId: expected, workspaceId: 'workspace-two' });
      expect(parseLocalPreferences(h.documents.get(PREFERENCES_DOCUMENT)!)).toMatchObject({
        modelId: expected,
        workspaceId: 'workspace-two',
      });
      expect(h.store.failure()).toBeNull();
      const restarted = new LocalPreferencesStore(h.storage, jest.fn());
      await restarted.restore();
      expect(restarted.get()).toEqual(h.store.get());
    },
  );

  it('does not publish an unconfirmed choice through an earlier queued save', async () => {
    const h = await preferenceStore();
    const write = h.storage.writeRuntimeDocument.getMockImplementation()!;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    h.storage.writeRuntimeDocument
      .mockImplementationOnce(async (name, contents) => {
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await write(name, contents);
      })
      .mockRejectedValueOnce(new Error('Queued model write failed.'));
    h.store.update({ workspaceId: 'workspace-two' });
    const earlier = h.store.save();
    await writing;
    const choosing = h.store.chooseModel('model-b');
    const outcome = choosing.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    h.store.update({ author: { name: 'Fixture', email: 'fixture@example.invalid' } });
    const later = h.store.save();
    finish();
    await earlier;
    expect(await outcome).toBeInstanceOf(Error);
    await later;
    expect(parseLocalPreferences(h.documents.get(PREFERENCES_DOCUMENT)!)).toEqual(h.store.get());
    expect(h.store.get()).toMatchObject({
      modelId: 'model-a',
      workspaceId: 'workspace-two',
      author: { name: 'Fixture', email: 'fixture@example.invalid' },
    });
    expect(h.store.failure()).toBeNull();
  });

  it('keeps a failure visible until a successful write contains all current settings', async () => {
    const h = await preferenceStore();
    h.storage.writeRuntimeDocument.mockRejectedValueOnce(new Error('Initial write failed.'));
    h.store.update({ workspaceId: 'workspace-two' });
    await expect(h.store.save()).rejects.toThrow('Initial write failed.');
    const write = h.storage.writeRuntimeDocument.getMockImplementation()!;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    h.storage.writeRuntimeDocument.mockImplementationOnce(async (name, contents) => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await write(name, contents);
    });
    h.store.update({ author: { name: 'Before', email: 'fixture@example.invalid' } });
    const stale = h.store.save();
    await writing;
    h.store.update({ author: { name: 'After', email: 'fixture@example.invalid' } });
    finish();
    await stale;
    expect(h.store.failure()?.message).toBe('Initial write failed.');
    await h.store.flush();
    expect(h.store.failure()).toBeNull();
    expect(parseLocalPreferences(h.documents.get(PREFERENCES_DOCUMENT)!)).toEqual(h.store.get());
  });
});

test('only absent preferences produce defaults; invalid stored data is never reset', () => {
  expect(parseLocalPreferences(null)).toEqual(emptyLocalPreferences());
  for (const raw of [
    '{',
    'null',
    '{}',
    '{"version":2}',
    JSON.stringify({ ...emptyLocalPreferences(), drafts: { a: 3 } }),
    JSON.stringify({ ...emptyLocalPreferences(), drafts: [] }),
  ]) {
    expect(() => parseLocalPreferences(raw)).toThrow();
  }
});

test('legacy inline drafts are read for migration but never written back into preferences', () => {
  const legacy = { '00000000-0000-4000-8000-000000000001': 'unfinished draft' };
  const stored = parseStoredLocalPreferences(
    JSON.stringify({ ...emptyLocalPreferences(), drafts: legacy }),
  );
  expect(stored).toEqual({ preferences: emptyLocalPreferences(), legacyDrafts: legacy });
  const written: unknown = JSON.parse(serializeLocalPreferences(stored.preferences));
  expect(written).toEqual({ ...emptyLocalPreferences(), drafts: {} });
  expect(parseStoredLocalPreferences(JSON.stringify(emptyLocalPreferences())).legacyDrafts).toEqual(
    {},
  );
});

test('preferences round-trip workspace, model, opaque account reference, and offline author', () => {
  const preferences = {
    ...emptyLocalPreferences(),
    workspaceId: 'local-workspace',
    modelId: 'qwen3-1.7b-q4-k-m',
    author: { name: 'Offline Author', email: 'author@example.invalid' },
    account: {
      providerId: 'github',
      host: 'github.com',
      id: '123',
      login: 'author',
      credentialRef: 'opaque-ref',
    },
  };
  expect(parseLocalPreferences(serializeLocalPreferences(preferences))).toEqual(preferences);
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
