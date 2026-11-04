jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../../features/on-device/models/engine', () => ({ loadNativeModelContext: jest.fn() }));

import { randomUUID } from 'expo-crypto';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import {
  serializeDraftEntries,
  useDraftController,
  type DraftController,
  type DraftStorage,
} from '../../features/chat/composer/controllers/draftController';
import { getWebProfilePersistenceKey } from '../../features/chat/helpers/persistence';
import { submissionScopeKey } from '../../features/chat/turn/controllers/submissionController';
import { draftDocument } from '../../features/on-device/runtime/drafts';
import { emptyLocalPreferences } from '../../features/on-device/runtime/preferences';
import { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import {
  createFakeOnDeviceNative,
  FakeLlama,
  FakeNetwork,
} from '../../features/on-device/runtime/testing';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';
import { importLegacyLocalDrafts } from './localDraftImport';

const MODEL_ID = 'qwen3-1.7b-q4-k-m';
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
// The web key keeps the composer's real persistence path free of native `Paths`.
const PLATFORM = 'web';
const DRAFTS_KEY = getWebProfilePersistenceKey('drafts.v2', LOCAL_PROFILE_ID)!;

/** The real runtime over in-memory native services holding `documents` (shared across restarts). */
async function started(documents: Map<string, string>): Promise<OnDeviceRuntime> {
  const fake = createFakeOnDeviceNative(new FakeLlama(), {
    downloaded: [MODEL_ID],
    workspaces: [{ id: 'workspace-one', name: 'Demo', isRepository: true }],
  });
  // Point the fake at the caller's map so a restart sees what the previous runtime wrote.
  fake.documents.clear();
  const native = {
    ...fake.native,
    readRuntimeDocument: async (name: string) => documents.get(name) ?? null,
    writeRuntimeDocument: async (name: string, value: string) => {
      documents.set(name, value);
    },
    listRuntimeDocuments: async (prefix: string) =>
      [...documents.keys()].filter((name) => name.startsWith(prefix)),
    removeRuntimeDocument: async (name: string) => {
      documents.delete(name);
    },
  };
  const runtime = new OnDeviceRuntime(native, { network: new FakeNetwork() });
  await runtime.initialize();
  return runtime;
}

function memoryStorage(initial: Record<string, string> = {}): DraftStorage & {
  values: Map<string, string>;
  write: jest.Mock;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read: jest.fn(async (path: string) => {
      const value = values.get(path);
      if (value === undefined) {
        throw new Error('missing');
      }
      return value;
    }),
    write: jest.fn(async (path: string, value: string) => {
      values.set(path, value);
    }),
    exists: jest.fn(async (path: string) => values.has(path)),
  };
}

/** What the shared composer shows when the user opens the local chat. */
async function composerDraft(storage: DraftStorage, chatId: string): Promise<string> {
  let controller: DraftController | null = null;
  function Probe() {
    controller = useDraftController(LOCAL_PROFILE_ID, chatId, storage, undefined, PLATFORM);
    return null;
  }
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(<Probe />);
    for (let index = 0; index < 20; index += 1) {
      await Promise.resolve();
    }
  });
  const draft = (controller as DraftController | null)?.draft ?? '';
  act(() => tree?.unmount());
  return draft;
}

/** Two local chats saved by a build from before the shared composer, each with an unsent draft. */
async function oldBuildDocuments(): Promise<Map<string, string>> {
  const documents = new Map<string, string>([
    [
      'preferences.json',
      JSON.stringify({
        ...emptyLocalPreferences(),
        modelId: MODEL_ID,
        workspaceId: 'workspace-one',
      }),
    ],
  ]);
  jest.mocked(randomUUID).mockReturnValueOnce(FIRST).mockReturnValueOnce(SECOND);
  const source = await started(documents);
  await source.createThread();
  await source.createThread();
  await source.dispose();
  documents.set(
    'preferences.json',
    JSON.stringify({
      ...JSON.parse(documents.get('preferences.json')!),
      drafts: { [FIRST]: 'inline draft from an early build' },
    }),
  );
  documents.set(
    draftDocument(SECOND),
    JSON.stringify({ version: 1, text: 'draft document from a later build' }),
  );
  return documents;
}

describe('importLegacyLocalDrafts', () => {
  it('moves inline and per-conversation drafts into the shared composer once, then drops them', async () => {
    const documents = await oldBuildDocuments();
    const storage = memoryStorage();
    const runtime = await started(documents);

    await importLegacyLocalDrafts(runtime, storage, PLATFORM);

    expect(await composerDraft(storage, FIRST)).toBe('inline draft from an early build');
    expect(await composerDraft(storage, SECOND)).toBe('draft document from a later build');
    // The runtime's copies are gone only now that the composer holds them.
    expect(JSON.parse(documents.get('preferences.json')!).drafts).toEqual({});
    expect(documents.has(draftDocument(SECOND))).toBe(false);
    expect(runtime.legacyDrafts().size).toBe(0);
    await runtime.dispose();

    // A later start has nothing left to import and never rewrites the composer's drafts.
    const restarted = await started(documents);
    storage.write.mockClear();
    await importLegacyLocalDrafts(restarted, storage, PLATFORM);
    expect(storage.write).not.toHaveBeenCalled();
    expect(await composerDraft(storage, FIRST)).toBe('inline draft from an early build');
    await restarted.dispose();
  });

  it('keeps every legacy byte when the composer write fails, and imports on the next start', async () => {
    const documents = await oldBuildDocuments();
    const storage = memoryStorage();
    storage.write.mockRejectedValueOnce(new Error('Disk full'));
    const runtime = await started(documents);

    await expect(importLegacyLocalDrafts(runtime, storage, PLATFORM)).rejects.toThrow('Disk full');
    expect(JSON.parse(documents.get('preferences.json')!).drafts).toEqual({
      [FIRST]: 'inline draft from an early build',
    });
    expect(documents.has(draftDocument(SECOND))).toBe(true);
    await runtime.dispose();

    const retried = await started(documents);
    await importLegacyLocalDrafts(retried, storage, PLATFORM);
    expect(await composerDraft(storage, FIRST)).toBe('inline draft from an early build');
    expect(await composerDraft(storage, SECOND)).toBe('draft document from a later build');
    await retried.dispose();
  });

  it('never replaces a newer composer draft; the older text is set aside with its bytes preserved', async () => {
    const documents = await oldBuildDocuments();
    const newer = serializeDraftEntries({
      [submissionScopeKey({ profileId: LOCAL_PROFILE_ID, threadId: SECOND })]: 'typed today',
    });
    const storage = memoryStorage({ [DRAFTS_KEY]: newer });
    const runtime = await started(documents);

    await importLegacyLocalDrafts(runtime, storage, PLATFORM);

    expect(await composerDraft(storage, SECOND)).toBe('typed today');
    expect(await composerDraft(storage, FIRST)).toBe('inline draft from an early build');
    expect(documents.has(draftDocument(SECOND))).toBe(false);
    expect([...documents].filter(([name]) => name.startsWith('quarantine-'))).toEqual([
      [
        expect.stringContaining(SECOND),
        JSON.stringify({ version: 1, text: 'draft document from a later build' }),
      ],
    ]);
    expect(runtime.issues()).toEqual([
      expect.objectContaining({
        kind: 'recovery',
        message: expect.stringContaining('newer draft'),
      }),
    ]);
    await runtime.dispose();
  });
});
