import { Platform } from 'react-native';

import {
  serializeDraftEntries,
  updateDraftEntries,
} from '../../features/chat/composer/controllers/draftController';
import {
  getChatDraftsPath,
  getWebProfilePersistenceKey,
  parseChatDrafts,
  type ProfilePersistenceStorage,
} from '../../features/chat/helpers/persistence';
import { getProfileStorage } from '../../features/chat/helpers/profileStorage';
import { submissionScopeKey } from '../../features/chat/turn/controllers/submissionController';
import type { LegacyDraftOutcome } from '../../features/on-device/runtime/drafts';
import type { OnDeviceRuntime } from '../../features/on-device/runtime/runtime';
import { LOCAL_PROFILE_ID } from '@shell/state/localProfile';

export type LegacyDraftSource = Pick<OnDeviceRuntime, 'legacyDrafts' | 'settleLegacyDrafts'>;

/**
 * Moves unsent drafts written by builds before the shared chat shell (inline in `preferences.json`
 * or in per-conversation draft documents) into the composer's draft store for the local profile.
 * A local chat's id is its conversation id. A chat that already has a composer draft keeps it, and
 * the older text is set aside with its bytes preserved. The runtime drops its copies only after
 * the composer's write succeeded, so the import is idempotent and simply retried after a failure;
 * once it has succeeded there is nothing left to import.
 *
 * Run it before the local transport is published: a mounted composer rewrites the whole store from
 * what it loaded, so an import after that could be lost.
 */
export async function importLegacyLocalDrafts(
  runtime: LegacyDraftSource,
  storage: ProfilePersistenceStorage = getProfileStorage(Platform.OS),
  platform: string = Platform.OS,
): Promise<void> {
  const legacy = runtime.legacyDrafts();
  if (legacy.size === 0) {
    return;
  }
  const path =
    platform === 'web'
      ? getWebProfilePersistenceKey('drafts.v2', LOCAL_PROFILE_ID)
      : getChatDraftsPath(LOCAL_PROFILE_ID);
  if (!path) {
    throw new Error('Composer drafts are unavailable on this device.');
  }
  const missing = storage.exists ? !(await storage.exists(path)) : false;
  const stored = missing ? {} : parseChatDrafts(await storage.read(path));
  let entries = stored;
  const outcomes = new Map<string, LegacyDraftOutcome>();
  for (const [threadId, text] of legacy) {
    const key = submissionScopeKey({ profileId: LOCAL_PROFILE_ID, threadId });
    const current = stored[key];
    if (current === undefined) {
      entries = updateDraftEntries(entries, key, text);
      outcomes.set(threadId, 'imported');
    } else {
      outcomes.set(threadId, current === text.replace(/\r\n/gu, '\n') ? 'imported' : 'superseded');
    }
  }
  if (entries !== stored) {
    await storage.write(path, serializeDraftEntries(entries));
  }
  await runtime.settleLegacyDrafts(outcomes);
}
