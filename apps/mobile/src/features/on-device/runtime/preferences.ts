import { isRecord } from '@shared/records';
import type { GitAccount } from '../auth/strategy';
import type { LocalGitIdentity } from '../git/gitTools';
import { quarantineDocument } from './quarantine';
import type { LocalDocumentPort } from './threads';

export interface LocalPreferences {
  version: 1;
  workspaceId: string | null;
  modelId: string | null;
  account: GitAccount | null;
  author: LocalGitIdentity | null;
}

/** Preferences plus drafts saved inline by builds that predate per-conversation draft documents. */
export interface StoredLocalPreferences {
  preferences: LocalPreferences;
  legacyDrafts: Record<string, string>;
}

export const PREFERENCES_DOCUMENT = 'preferences.json';

export function emptyLocalPreferences(): LocalPreferences {
  return { version: 1, workspaceId: null, modelId: null, account: null, author: null };
}

/** Keeps an empty `drafts` record so older builds can still read the document. */
export function serializeLocalPreferences(preferences: LocalPreferences): string {
  return JSON.stringify({ ...preferences, drafts: {} });
}

function nullable(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !value) {
    throw new Error('Local preference text is invalid.');
  }
  return value;
}

function account(value: unknown): GitAccount | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || value['providerId'] !== 'github' || value['host'] !== 'github.com') {
    throw new Error('Local Git account data is invalid.');
  }
  const id = nullable(value['id']);
  const login = nullable(value['login']);
  const credentialRef = nullable(value['credentialRef']);
  if (!id || !login || !credentialRef) {
    throw new Error('Local Git account data is incomplete.');
  }
  return { providerId: 'github', host: 'github.com', id, login, credentialRef };
}

function author(value: unknown): LocalGitIdentity | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value['name'] !== 'string' || typeof value['email'] !== 'string') {
    throw new Error('Local Git author data is invalid.');
  }
  return { name: value['name'], email: value['email'] };
}

export function parseLocalPreferences(raw: string | null): LocalPreferences {
  return parseStoredLocalPreferences(raw).preferences;
}

export function parseStoredLocalPreferences(raw: string | null): StoredLocalPreferences {
  if (raw === null) {
    return { preferences: emptyLocalPreferences(), legacyDrafts: {} };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Local preferences are damaged. Their data has been preserved.');
    }
    throw error;
  }
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    (value['drafts'] !== undefined && !isRecord(value['drafts']))
  ) {
    throw new Error('Local preferences have an unsupported format.');
  }
  const drafts: Record<string, string> = {};
  for (const [key, draft] of Object.entries(isRecord(value['drafts']) ? value['drafts'] : {})) {
    if (typeof draft !== 'string') {
      throw new Error('A local draft is invalid.');
    }
    drafts[key] = draft;
  }
  return {
    preferences: {
      version: 1,
      workspaceId: nullable(value['workspaceId']),
      modelId: nullable(value['modelId']),
      account: account(value['account']),
      author: author(value['author']),
    },
    legacyDrafts: drafts,
  };
}

export interface LocalPreferencesRestore {
  legacyDrafts: Record<string, string>;
  /** A user-facing notice when damaged or unreadable settings were not loaded. */
  notice: string | null;
}

/** Owns `preferences.json`: damaged settings are set aside instead of blocking startup. */
export class LocalPreferencesStore {
  private value = emptyLocalPreferences();
  private loaded = false;
  private dirty = false;
  private failureValue: Error | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: LocalDocumentPort,
    private readonly changed: (kind: 'value' | 'persistence') => void,
  ) {}

  get(): LocalPreferences {
    return this.value;
  }

  failure(): Error | null {
    return this.failureValue;
  }

  async restore(): Promise<LocalPreferencesRestore> {
    let raw: string | null;
    try {
      raw = await this.storage.readRuntimeDocument(PREFERENCES_DOCUMENT);
    } catch {
      return {
        legacyDrafts: {},
        notice:
          'Local settings could not be read and were left in place. Setting changes will not be saved until the app restarts.',
      };
    }
    try {
      const stored = parseStoredLocalPreferences(raw);
      this.value = stored.preferences;
      this.loaded = true;
      return { legacyDrafts: stored.legacyDrafts, notice: null };
    } catch {
      if (await quarantineDocument(this.storage, PREFERENCES_DOCUMENT, raw)) {
        this.loaded = true;
        return {
          legacyDrafts: {},
          notice:
            'Local settings were damaged and have been set aside with their data preserved. Choose your model, workspace, and GitHub account again.',
        };
      }
      return {
        legacyDrafts: {},
        notice:
          'Local settings are damaged and could not be set aside, so they were left in place. Setting changes will not be saved until the app restarts.',
      };
    }
  }

  update(patch: Partial<LocalPreferences>): void {
    this.value = { ...this.value, ...patch };
    this.dirty = true;
    this.changed('value');
  }

  save(): Promise<void> {
    if (!this.loaded) {
      return Promise.reject(
        new Error(
          'Local settings were left in place and cannot be changed until the app restarts.',
        ),
      );
    }
    const contents = serializeLocalPreferences(this.value);
    const write = this.writes.then(() =>
      this.storage.writeRuntimeDocument(PREFERENCES_DOCUMENT, contents),
    );
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write.then(
      () => {
        if (contents === serializeLocalPreferences(this.value)) {
          this.dirty = false;
        }
        if (this.failureValue) {
          this.failureValue = null;
          this.changed('persistence');
        }
      },
      (error: unknown) => {
        this.failureValue =
          error instanceof Error ? error : new Error('Local settings could not be saved.');
        this.changed('persistence');
        throw error;
      },
    );
  }

  /** Writes only unsaved or previously failed changes; never overwrites settings left in place. */
  flush(): Promise<void> {
    return this.loaded && (this.dirty || this.failureValue) ? this.save() : Promise.resolve();
  }
}
