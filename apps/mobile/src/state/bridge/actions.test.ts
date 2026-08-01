import * as FileSystem from 'expo-file-system/legacy';

import { createDefaultAppStateData } from '../../appState';
import {
  getChatSummaryCacheGeneration,
  loadChatSummaryCache,
  persistChatSummaries,
} from '../../chatSummaryCache';
import { onboardingModeAtom } from '../navigation/atoms';
import { createTestStore } from '../testing';
import {
  clearSavedBridgesAtom,
  deleteBridgeProfileAtom,
  saveBridgeProfileAtom,
} from './actions';
import { activeBridgeProfileAtom } from './atoms';

/**
 * Regression coverage for the chat-summary-cache purge barrier: a drawer
 * debounce timer can capture chat summaries for a bridge profile and only
 * flush the write well after that profile has been deleted, cleared, or
 * edited in place. These tests reproduce the actual timing sequence - a
 * pending write scheduled *before* the bridge action, flushed *after* it
 * completes - rather than only asserting on helper return values.
 */
describe('bridge profile purge coordinates with pending summary writes', () => {
  function mockFileSystem() {
    const originalDirectory = FileSystem.documentDirectory;
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: 'file:///documents/',
    });
    const files = new Map<string, string>();
    jest.spyOn(FileSystem, 'makeDirectoryAsync').mockResolvedValue(undefined);
    jest.spyOn(FileSystem, 'readAsStringAsync').mockImplementation(async (path: string) => {
      const raw = files.get(path);
      if (raw === undefined) throw new Error('missing');
      return raw;
    });
    jest
      .spyOn(FileSystem, 'writeAsStringAsync')
      .mockImplementation(async (path: string, raw: string) => {
        files.set(path, raw);
      });
    jest.spyOn(FileSystem, 'deleteAsync').mockImplementation(async (path: string) => {
      files.delete(path);
    });
    return {
      restore: () => {
        Object.defineProperty(FileSystem, 'documentDirectory', {
          configurable: true,
          value: originalDirectory,
        });
      },
    };
  }

  function summary(id: string) {
    return {
      id,
      title: `Chat ${id}`,
      status: 'complete' as const,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      statusUpdatedAt: '2026-07-01T00:00:00.000Z',
      lastMessagePreview: id,
    };
  }

  function storeWithProfile(profileId: string) {
    const data = createDefaultAppStateData();
    data.bridgeProfiles = {
      activeProfileId: profileId,
      profiles: [
        {
          id: profileId,
          name: 'Bridge',
          bridgeUrl: 'https://bridge.test',
          bridgeToken: 'token-one',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    };
    return createTestStore({ data });
  }

  it('drops a pending write scheduled before profile deletion and flushed after it completes', async () => {
    const { restore } = mockFileSystem();
    try {
      const profileId = 'profile-delete';
      await persistChatSummaries(profileId, [summary('kept')]);
      // A drawer debounce timer captures the current generation before the
      // user deletes the profile...
      const staleGeneration = getChatSummaryCacheGeneration(profileId);

      const store = storeWithProfile(profileId);
      await store.set(deleteBridgeProfileAtom, profileId);

      // ...but its setTimeout only fires afterward, once the profile (and
      // its cache) are already gone.
      await persistChatSummaries(profileId, [summary('ghost')], undefined, staleGeneration);

      await expect(loadChatSummaryCache(profileId)).resolves.toMatchObject({ entries: [] });
    } finally {
      restore();
    }
  });

  it('drops a pending write scheduled before clearing all profiles and flushed after it completes', async () => {
    const { restore } = mockFileSystem();
    try {
      const profileId = 'profile-clear';
      await persistChatSummaries(profileId, [summary('kept')]);
      const staleGeneration = getChatSummaryCacheGeneration(profileId);

      const store = storeWithProfile(profileId);
      await store.set(clearSavedBridgesAtom);

      await persistChatSummaries(profileId, [summary('ghost')], undefined, staleGeneration);

      await expect(loadChatSummaryCache(profileId)).resolves.toMatchObject({ entries: [] });
    } finally {
      restore();
    }
  });

  it('drops a pending write scheduled before an in-place bridge identity edit and flushed after it completes, without hydrating old-identity data', async () => {
    const { restore } = mockFileSystem();
    try {
      const profileId = 'profile-edit';
      await persistChatSummaries(profileId, [summary('old-identity-chat')]);
      const staleGeneration = getChatSummaryCacheGeneration(profileId);

      const store = storeWithProfile(profileId);
      store.set(onboardingModeAtom, 'edit');
      expect(store.get(activeBridgeProfileAtom)?.id).toBe(profileId);

      // Edit the bridge URL/token in place - the profile id is preserved,
      // but the identity behind it changes, so its summary cache must be
      // purged even though the cache file path (keyed by profileId) does
      // not change.
      await store.set(saveBridgeProfileAtom, {
        bridgeUrl: 'https://bridge-two.test',
        bridgeToken: 'token-two',
      });

      // A pending write captured before the edit (old-identity chats) must
      // not resurrect the purged cache once it finally flushes.
      await persistChatSummaries(
        profileId,
        [summary('old-identity-chat')],
        undefined,
        staleGeneration,
      );
      await expect(loadChatSummaryCache(profileId)).resolves.toMatchObject({ entries: [] });

      // Fresh writes under the new identity/generation still work normally.
      await persistChatSummaries(profileId, [summary('new-identity-chat')]);
      await expect(loadChatSummaryCache(profileId)).resolves.toMatchObject({
        entries: [{ summary: { id: 'new-identity-chat' } }],
      });
    } finally {
      restore();
    }
  });
});
