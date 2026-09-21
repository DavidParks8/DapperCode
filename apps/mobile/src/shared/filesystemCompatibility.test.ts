import { File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import { getChatDraftsPath } from '../features/chat/helpers/persistence';
import { getProfileStorage } from '../features/chat/helpers/profileStorage';
import {
  deleteChatSnapshotCache,
  getChatSnapshotCachePath,
  loadChatSnapshotCache,
} from '../shell/session/chatSnapshotCache';
import {
  deleteChatSummaryCache,
  getChatSummaryCachePath,
  loadChatSummaryCache,
} from '../shell/session/chatSummaryCache';
import { loadAutoStoreReviewState, saveAutoStoreReviewState } from '../shell/storeReview';
import { fileSystemMock } from './testing/expoFileSystemMock';

afterEach(() => jest.restoreAllMocks());

it.each([
  ['a/b', 'a%2Fb'],
  ['profile % caf\u00e9', 'profile%20%25%20caf%C3%A9'],
  ['%2F', '%252F'],
])(
  'preserves existing encoded paths for profile %s with either base URI form',
  (profile, encoded) => {
    expect(getChatDraftsPath(profile)).toBe(
      `file:///documents/dappercode-profile-${encoded}-chat-drafts.json`,
    );
    for (const base of ['file:///documents', 'file:///documents/']) {
      expect(getChatSnapshotCachePath(profile, base)).toBe(
        `file:///documents/dappercode-chat-cache/${encoded}/snapshots.json`,
      );
      expect(getChatSummaryCachePath(profile, base)).toBe(
        `file:///documents/dappercode-chat-cache/${encoded}/summaries.json`,
      );
    }
  },
);

it('keeps synchronous native write errors on the asynchronous persistence boundary', async () => {
  jest.spyOn(File.prototype, 'write').mockImplementation(() => {
    throw new Error('storage full');
  });
  await expect(
    getProfileStorage('ios').write('file:///documents/draft.json', '{}'),
  ).rejects.toThrow('storage full');
  await expect(
    saveAutoStoreReviewState({ accumulatedForegroundMs: 42, automaticRequestAt: null }),
  ).rejects.toThrow('storage full');
});

it('makes repeated deletion of missing cache files a no-op', async () => {
  fileSystemMock.exists.mockReturnValue(false);
  await deleteChatSnapshotCache('absent');
  await deleteChatSnapshotCache('absent');
  await deleteChatSummaryCache('absent');
  await deleteChatSummaryCache('absent');
  expect(fileSystemMock.deleteFile).not.toHaveBeenCalled();
});

it('does not access unsupported native Paths or File APIs on web', async () => {
  const originalPlatform = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  jest.spyOn(Paths, 'document', 'get').mockImplementation(() => {
    throw new Error('native paths unavailable on web');
  });
  try {
    expect(getChatDraftsPath('profile')).toBeNull();
    expect(getChatSnapshotCachePath('profile')).toBeNull();
    expect(getChatSummaryCachePath('profile')).toBeNull();
    await expect(loadChatSnapshotCache('profile')).resolves.toMatchObject({ entries: [] });
    await expect(loadChatSummaryCache('profile')).resolves.toMatchObject({ entries: [] });
    await loadAutoStoreReviewState();
    await saveAutoStoreReviewState({ accumulatedForegroundMs: 42, automaticRequestAt: null });
    expect(fileSystemMock.read).not.toHaveBeenCalled();
    expect(fileSystemMock.write).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  }
});
