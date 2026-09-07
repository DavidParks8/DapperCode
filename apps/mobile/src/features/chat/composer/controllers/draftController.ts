import * as FileSystem from 'expo-file-system/legacy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { mergeRecoveredDraft } from '@shell/session/interruptedChatCreation';

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
const EMPTY_RECOVERED_DRAFT = '\u0000dappercode-empty-draft';

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
  preserveEmpty = false,
): Record<string, string> {
  const next = { ...entries };
  if (draft.trim()) {
    next[ownerKey] = draft;
  } else if (preserveEmpty) {
    next[ownerKey] = EMPTY_RECOVERED_DRAFT;
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
  restoring: boolean;
  persistenceError: ProfilePersistenceError | null;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  editDraft: React.Dispatch<React.SetStateAction<string>>;
  clearDraft: () => void;
  clearForSubmission: (snapshot: SubmissionDraftSnapshot) => number | null;
  commitSubmissionClear: (submission: {
    draft: string;
    clearedDraft: string | null;
    clearedDraftEntries: Array<{ scopeKey: string; draft: string }>;
    clearedRevision: number | null;
    clearedScopeKey: string | null;
  }) => void;
  transferScopeDraft: (fromScopeKey: string, toScopeKey: string) => void;
  snapshot: () => SubmissionDraftSnapshot;
}

export interface DraftRecovery {
  draft: string;
  sourceScopeKey: string;
  targetScopeKey: string;
  consumeOnEdit?: boolean;
  savedDraftReplacesOriginal?: boolean;
  onConsumed: () => void | Promise<void>;
}

function resolveHydratedRecoveryDraft(
  entries: Readonly<Record<string, string>>,
  recovery: DraftRecovery,
): string {
  const hasTargetDraft = Object.hasOwn(entries, recovery.targetScopeKey);
  const storedTargetDraft = entries[recovery.targetScopeKey] ?? '';
  const targetDraft = storedTargetDraft === EMPTY_RECOVERED_DRAFT ? '' : storedTargetDraft;
  return recovery.savedDraftReplacesOriginal && hasTargetDraft
    ? targetDraft
    : mergeRecoveredDraft(
        mergeRecoveredDraft(recovery.draft, targetDraft),
        entries[recovery.sourceScopeKey] ?? '',
      );
}

export function useDraftController(
  profileId: string,
  chatId: string | null,
  storage?: DraftStorage,
  onPersistenceError?: (error: ProfilePersistenceError) => void,
  platform: string = Platform.OS,
  recovery?: DraftRecovery,
): DraftController {
  const resolvedStorage = storage ?? (platform === 'web' ? webDraftStorage : fileDraftStorage);
  const scopeKey = submissionScopeKey({ profileId, threadId: chatId });
  const [draft, setDraftState] = useState(recovery?.draft ?? '');
  const [ownerKey, setOwnerKey] = useState(scopeKey);
  // Mirrors `ownerKey` synchronously. React batches `setOwnerKey` into the next render, so an
  // effect that runs later in the *same* commit (e.g. the persist-trigger effect below) would
  // otherwise still observe the stale `ownerKey` state and could misattribute the current draft
  // to the wrong scope. Reading this ref instead keeps every effect within a commit consistent.
  const ownerKeyRef = useRef(scopeKey);
  const [loaded, setLoaded] = useState(false);
  const [savingRecovery, setSavingRecovery] = useState(false);
  const [persistenceError, setPersistenceError] = useState<ProfilePersistenceError | null>(null);
  const entriesRef = useRef<Record<string, string>>({});
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePersistRef = useRef<(delay?: number) => void>(() => undefined);
  const writeChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const recoveryConsumptionRef = useRef<DraftRecovery | null>(null);
  const draftRef = useRef(recovery?.draft ?? '');
  const recoveryRef = useRef(recovery);
  recoveryRef.current = recovery;
  const dirtyRef = useRef(false);
  const scopeKeyRef = useRef(scopeKey);
  const revisionRef = useRef(0);
  // Tracks whether the *current* scope's draft has been edited since it became current.
  // A delayed hydration read must never clobber such an edit, even if the read was already
  // in flight when the edit happened (e.g. rapid typing right after opening a chat).
  const unsyncedEditRef = useRef(false);
  const suppressedPersistDraftRef = useRef<string | null>(null);
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
    (entries: Readonly<Record<string, string>>): Promise<boolean> => {
      if (!dirtyRef.current) {
        return Promise.resolve(true);
      }
      if (!paths.target) {
        reportPersistenceError('write', new Error('Persistence path is unavailable.'));
        return Promise.resolve(false);
      }
      const path = paths.target;
      const write = writeChainRef.current.then(async () => {
        try {
          await resolvedStorage.write(path, serializeDraftEntries(entries));
          if (entriesRef.current === entries) {
            const pendingRecovery = recoveryConsumptionRef.current;
            if (pendingRecovery) {
              await pendingRecovery.onConsumed();
              recoveryConsumptionRef.current = null;
              setSavingRecovery(false);
            }
            dirtyRef.current = false;
          }
          setPersistenceError(null);
          return true;
        } catch (cause) {
          reportPersistenceError('write', cause);
          return false;
        }
      });
      writeChainRef.current = write;
      return write;
    },
    [paths.target, reportPersistenceError, resolvedStorage],
  );
  const schedulePersist = useCallback(
    (delay = 180) => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
      }
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        void persist(entriesRef.current).then((saved) => {
          if (!saved && recoveryConsumptionRef.current) {
            schedulePersistRef.current(1000);
          }
        });
      }, delay);
    },
    [persist],
  );
  schedulePersistRef.current = schedulePersist;
  const editDraft = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (next) => {
      const value = typeof next === 'function' ? next(draftRef.current) : next;
      const recovery = recoveryRef.current;
      if (value === draftRef.current) {
        return;
      }
      setDraft(value);
      if (!recovery || recovery.consumeOnEdit === false) {
        return;
      }
      setSavingRecovery(true);
      recoveryConsumptionRef.current = recovery;
      const owner = ownerKeyRef.current;
      const entries = updateDraftEntries(entriesRef.current, owner, value);
      entriesRef.current = entries;
      dirtyRef.current = true;
      void persist(entries).then((saved) => {
        if (!saved && recoveryConsumptionRef.current === recovery) {
          schedulePersist(1000);
        }
      });
    },
    [persist, schedulePersist, setDraft],
  );

  const setOwner = useCallback((key: string) => {
    ownerKeyRef.current = key;
    setOwnerKey(key);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    entriesRef.current = {};

    const load = async () => {
      const interrupted = recoveryRef.current;
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
      if (
        !cancelled &&
        interrupted &&
        !unsyncedEditRef.current &&
        scopeKeyRef.current === interrupted.targetScopeKey
      ) {
        const recovered = resolveHydratedRecoveryDraft(entriesRef.current, interrupted);
        entriesRef.current = updateDraftEntries(
          entriesRef.current,
          interrupted.targetScopeKey,
          recovered,
        );
        delete entriesRef.current[interrupted.sourceScopeKey];
        dirtyRef.current = true;
        if (interrupted.consumeOnEdit !== false && recovered.trim() !== interrupted.draft.trim()) {
          setSavingRecovery(true);
          recoveryConsumptionRef.current = interrupted;
        }
        const saved = await persist(entriesRef.current);
        if (!saved && recoveryConsumptionRef.current) {
          schedulePersistRef.current(1000);
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
  }, [normalizedProfileId, paths, persist, reportPersistenceError, resolvedStorage]);

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
    const storedDraft = entriesRef.current[scopeKey] ?? '';
    const nextDraft = storedDraft === EMPTY_RECOVERED_DRAFT ? '' : storedDraft;
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
    if (suppressedPersistDraftRef.current === draft) {
      suppressedPersistDraftRef.current = null;
      return;
    }
    suppressedPersistDraftRef.current = null;
    const recovery = recoveryRef.current;
    const preserveEmpty =
      recovery?.savedDraftReplacesOriginal === true && recovery.targetScopeKey === owner;
    entriesRef.current = updateDraftEntries(entriesRef.current, owner, draft, preserveEmpty);
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
    restoring: Boolean(recovery && (!loaded || savingRecovery)),
    persistenceError,
    setDraft,
    editDraft,
    clearDraft: useCallback(() => setDraft(''), [setDraft]),
    clearForSubmission: useCallback(
      (snapshot: SubmissionDraftSnapshot) => {
        if (
          draftRef.current === '' ||
          scopeKeyRef.current !== snapshot.scopeKey ||
          revisionRef.current !== snapshot.revision ||
          draftRef.current !== snapshot.value
        ) {
          return null;
        }
        entriesRef.current = updateDraftEntries(
          entriesRef.current,
          snapshot.scopeKey,
          snapshot.value,
        );
        dirtyRef.current = true;
        schedulePersist();
        draftRef.current = '';
        revisionRef.current += 1;
        suppressedPersistDraftRef.current = '';
        setDraftState('');
        return revisionRef.current;
      },
      [schedulePersist],
    ),
    commitSubmissionClear: useCallback(
      (submission) => {
        if (!submission.clearedScopeKey || submission.clearedRevision === null) {
          return;
        }
        suppressedPersistDraftRef.current = null;
        for (const entry of submission.clearedDraftEntries) {
          const currentOwnsScope = scopeKeyRef.current === entry.scopeKey;
          const currentChanged =
            currentOwnsScope &&
            (revisionRef.current !== submission.clearedRevision || draftRef.current !== '');
          if (currentChanged) {
            entriesRef.current = updateDraftEntries(
              entriesRef.current,
              entry.scopeKey,
              draftRef.current,
            );
          } else if (entriesRef.current[entry.scopeKey] === entry.draft) {
            entriesRef.current = updateDraftEntries(entriesRef.current, entry.scopeKey, '');
          }
        }
        dirtyRef.current = true;
        schedulePersist();
      },
      [schedulePersist],
    ),
    transferScopeDraft: useCallback(
      (fromScopeKey: string, toScopeKey: string) => {
        if (
          scopeKeyRef.current !== fromScopeKey ||
          toScopeKey === fromScopeKey ||
          !draftRef.current.trim()
        ) {
          return;
        }
        entriesRef.current = updateDraftEntries(entriesRef.current, fromScopeKey, '');
        entriesRef.current = updateDraftEntries(entriesRef.current, toScopeKey, draftRef.current);
        scopeKeyRef.current = toScopeKey;
        ownerKeyRef.current = toScopeKey;
        setOwnerKey(toScopeKey);
        unsyncedEditRef.current = true;
        dirtyRef.current = true;
        schedulePersist();
      },
      [schedulePersist],
    ),
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
