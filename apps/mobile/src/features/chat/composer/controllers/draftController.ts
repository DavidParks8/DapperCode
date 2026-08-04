import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import {
  CHAT_DRAFTS_VERSION,
  ProfilePersistenceError,
  type ProfilePersistenceStorage,
  getChatDraftsPath,
  getWebProfilePersistenceKey,
  parseChatDrafts,
} from '../../helpers/helpers';
import {
  submissionScopeKey,
  type SubmissionDraftSnapshot,
} from '../../turn/controllers/submissionController';

export type DraftStorage = ProfilePersistenceStorage;

const fileDraftStorage: DraftStorage = {
  read: FileSystem.readAsStringAsync,
  write: FileSystem.writeAsStringAsync,
  exists: async (path) => (await FileSystem.getInfoAsync(path))?.exists === true,
};

interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const webDraftStorage: DraftStorage = {
  read: (key) => {
    const value = getWebStorage()?.getItem(key);
    if (value == null) {
      return Promise.reject(new Error('missing'));
    }
    return Promise.resolve(value);
  },
  write: (key, value) => {
    const storage = getWebStorage();
    if (!storage) {
      return Promise.reject(new Error('Browser storage is unavailable.'));
    }
    storage.setItem(key, value);
    return Promise.resolve();
  },
  exists: (key) => Promise.resolve(getWebStorage()?.getItem(key) != null),
};

export function updateDraftEntries(
  entries: Readonly<Record<string, string>>,
  ownerKey: string,
  draft: string,
): Record<string, string> {
  const next = { ...entries };
  if (draft.trim()) {
    next[ownerKey] = draft;
  } else {
    delete next[ownerKey];
  }
  return next;
}

export function serializeDraftEntries(entries: Readonly<Record<string, string>>): string {
  return JSON.stringify({ version: CHAT_DRAFTS_VERSION, entries });
}

export interface DraftController {
  draft: string;
  persistenceError: ProfilePersistenceError | null;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  clearDraft: () => void;
  snapshot: () => SubmissionDraftSnapshot;
}

export function useDraftController(
  profileId: string,
  chatId: string | null,
  storage?: DraftStorage,
  onPersistenceError?: (error: ProfilePersistenceError) => void,
  platform: string = Platform.OS,
): DraftController {
  const resolvedStorage = storage ?? (platform === 'web' ? webDraftStorage : fileDraftStorage);
  const scopeKey = submissionScopeKey({ profileId, threadId: chatId });
  const [draft, setDraftState] = useState('');
  const [ownerKey, setOwnerKey] = useState(scopeKey);
  // Mirrors `ownerKey` synchronously. React batches `setOwnerKey` into the next render, so an
  // effect that runs later in the *same* commit (e.g. the persist-trigger effect below) would
  // otherwise still observe the stale `ownerKey` state and could misattribute the current draft
  // to the wrong scope. Reading this ref instead keeps every effect within a commit consistent.
  const ownerKeyRef = useRef(scopeKey);
  const [loaded, setLoaded] = useState(false);
  const [persistenceError, setPersistenceError] = useState<ProfilePersistenceError | null>(null);
  const entriesRef = useRef<Record<string, string>>({});
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef('');
  const dirtyRef = useRef(false);
  const scopeKeyRef = useRef(scopeKey);
  const revisionRef = useRef(0);
  // Tracks whether the *current* scope's draft has been edited since it became current.
  // A delayed hydration read must never clobber such an edit, even if the read was already
  // in flight when the edit happened (e.g. rapid typing right after opening a chat).
  const unsyncedEditRef = useRef(false);
  const normalizedProfileId = profileId.trim();
  const paths = useMemo(
    () => ({
      target:
        platform === 'web'
          ? getWebProfilePersistenceKey('drafts.v2', normalizedProfileId)
          : getChatDraftsPath(normalizedProfileId),
    }),
    [normalizedProfileId, platform],
  );

  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey;
    revisionRef.current += 1;
    // A new scope has no edits yet; any pending hydration read may safely apply once it lands.
    unsyncedEditRef.current = false;
  }

  const reportPersistenceError = useCallback(
    (operation: 'write', cause: unknown) => {
      const error = new ProfilePersistenceError('chat drafts', operation, { cause });
      setPersistenceError(error);
      onPersistenceError?.(error);
    },
    [onPersistenceError],
  );

  const setDraft = useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    if (value === draftRef.current) {
      return;
    }
    draftRef.current = value;
    revisionRef.current += 1;
    unsyncedEditRef.current = true;
    setDraftState(value);
  }, []);

  const persist = useCallback(
    async (entries: Readonly<Record<string, string>>) => {
      if (!dirtyRef.current) {
        return;
      }
      if (!paths.target) {
        reportPersistenceError('write', new Error('Persistence path is unavailable.'));
        return;
      }
      try {
        await resolvedStorage.write(paths.target, serializeDraftEntries(entries));
        if (entriesRef.current === entries) {
          dirtyRef.current = false;
        }
        setPersistenceError(null);
      } catch (cause) {
        reportPersistenceError('write', cause);
      }
    },
    [paths.target, reportPersistenceError, resolvedStorage],
  );

  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      void persist(entriesRef.current);
    }, 180);
  }, [persist]);

  const setOwner = useCallback((key: string) => {
    ownerKeyRef.current = key;
    setOwnerKey(key);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    entriesRef.current = {};

    const load = async () => {
      if (paths.target) {
        try {
          const raw = await resolvedStorage.read(paths.target);
          if (!cancelled) {
            entriesRef.current = parseChatDrafts(raw);
          }
        } catch {
          if (!cancelled) {
            entriesRef.current = {};
          }
        }
      }
      if (!cancelled) {
        setLoaded(true);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [normalizedProfileId, paths, reportPersistenceError, resolvedStorage]);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    scopeKeyRef.current = scopeKey;
    // Persisted entries may have finished loading after the user already started typing into
    // this same scope (e.g. rapid typing right after navigating, before the read resolved).
    // Attribute the edit to `scopeKey` directly (always current) rather than the `ownerKey`
    // state, which only catches up on the next render and would otherwise race with this one.
    if (unsyncedEditRef.current) {
      entriesRef.current = updateDraftEntries(entriesRef.current, scopeKey, draftRef.current);
      dirtyRef.current = true;
      setOwner(scopeKey);
      schedulePersist();
      return;
    }
    const nextDraft = entriesRef.current[scopeKey] ?? '';
    draftRef.current = nextDraft;
    revisionRef.current += 1;
    setOwner(scopeKey);
    setDraftState((current) => (current === nextDraft ? current : nextDraft));
  }, [loaded, scopeKey, schedulePersist, setOwner]);

  useEffect(() => {
    if (!loaded) {
      return;
    }
    const owner = ownerKeyRef.current;
    const previous = entriesRef.current[owner] ?? '';
    if (previous === draft) {
      return;
    }
    entriesRef.current = updateDraftEntries(entriesRef.current, owner, draft);
    dirtyRef.current = true;
    schedulePersist();
  }, [draft, loaded, ownerKey, schedulePersist]);

  useEffect(
    () => () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
      }
      void persist(entriesRef.current);
    },
    [persist],
  );

  return {
    draft,
    persistenceError,
    setDraft,
    clearDraft: useCallback(() => setDraft(''), [setDraft]),
    snapshot: useCallback(
      () => ({
        scopeKey: scopeKeyRef.current,
        value: draftRef.current,
        revision: revisionRef.current,
      }),
      [],
    ),
  };
}

function getWebStorage(): WebStorageLike | null {
  if (typeof globalThis !== 'object' || globalThis === null) {
    return null;
  }
  const storage = (globalThis as typeof globalThis & { localStorage?: Partial<WebStorageLike> })
    .localStorage;
  return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
    ? storage
    : null;
}
