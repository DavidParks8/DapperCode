import { isRecord } from '@shared/records';
import type { GitAccount } from '../auth/strategy';
import type { LocalGitIdentity } from '../git/gitTools';
import { quarantineDocument } from './quarantine';
import { validSkillRule, type LocalSkillRule } from './skillConfig';
import type { LocalDocumentPort } from './threads';

export interface LocalPreferences {
  version: 1;
  workspaceId: string | null;
  modelId: string | null;
  account: GitAccount | null;
  author: LocalGitIdentity | null;
  /**
   * Skill IDs turned off with the Copilot CLI-style `/skills` disable: user `deny` rules applied
   * after `skillRules`, so the per-skill switch always wins. Absent means none.
   */
  disabledSkills?: string[];
  /** Device-owner OpenCode `skill` rules, after project rules (last match wins). */
  skillRules?: LocalSkillRule[];
  /** `false` turns every skill off: no catalog, tool, slash commands, or mentions. */
  skillsEnabled?: boolean;
  /** Personal HTTPS skill catalogs, OpenCode's global `skills` URLs. */
  skillCatalogs?: string[];
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

/**
 * Always writes a `drafts` record so older builds can still read the document. It holds only
 * legacy inline drafts that have not yet been confirmed in their own draft documents.
 */
export function serializeLocalPreferences(
  preferences: LocalPreferences,
  legacyDrafts: Readonly<Record<string, string>> = {},
): string {
  return JSON.stringify({ ...preferences, drafts: legacyDrafts });
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

function skillPreferences(value: Record<string, unknown>): Partial<LocalPreferences> {
  const { disabledSkills, skillRules, skillsEnabled, skillCatalogs } = value;
  const texts = (list: unknown) =>
    list === undefined || (Array.isArray(list) && list.every((name) => typeof name === 'string'));
  if (
    !texts(disabledSkills) ||
    !texts(skillCatalogs) ||
    (skillRules !== undefined &&
      (!Array.isArray(skillRules) || !skillRules.every(validSkillRule))) ||
    (skillsEnabled !== undefined && typeof skillsEnabled !== 'boolean')
  ) {
    throw new Error('Local skill preferences are invalid.');
  }
  return Object.fromEntries(
    Object.entries({ disabledSkills, skillRules, skillsEnabled, skillCatalogs }).filter(
      ([, entry]) => entry !== undefined,
    ),
  );
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
      ...skillPreferences(value),
    },
    legacyDrafts: drafts,
  };
}

export interface LocalPreferencesRestore {
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
  /** Inline drafts from older builds, kept in the document until each one is confirmed. */
  private legacyDrafts: Record<string, string> = {};

  constructor(
    private readonly storage: LocalDocumentPort,
    private readonly changed: (kind: 'value' | 'persistence') => void,
  ) {}

  get(): LocalPreferences {
    return this.value;
  }

  pendingLegacyDrafts(): Readonly<Record<string, string>> {
    return this.legacyDrafts;
  }

  /** Drops a legacy inline draft once its draft document is durable or it is obsolete. */
  settleLegacyDraft(threadId: string): void {
    if (Object.hasOwn(this.legacyDrafts, threadId)) {
      this.legacyDrafts = Object.fromEntries(
        Object.entries(this.legacyDrafts).filter(([id]) => id !== threadId),
      );
      this.dirty = true;
    }
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
        notice:
          'Local settings could not be read and were left in place. Setting changes will not be saved until the app restarts.',
      };
    }
    try {
      const stored = parseStoredLocalPreferences(raw);
      this.value = stored.preferences;
      this.legacyDrafts = stored.legacyDrafts;
      this.loaded = true;
      return { notice: null };
    } catch {
      if (await quarantineDocument(this.storage, PREFERENCES_DOCUMENT, raw)) {
        this.loaded = true;
        return {
          notice:
            'Local settings were damaged and have been set aside with their data preserved. Choose your model, workspace, and GitHub account again.',
        };
      }
      return {
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

  /** Unrelated saves must never publish an unconfirmed model choice. */
  chooseModel(modelId: string): Promise<void> {
    return this.persist(modelId);
  }

  save(): Promise<void> {
    return this.persist();
  }

  private persist(modelId?: string): Promise<void> {
    if (!this.loaded) {
      return Promise.reject(
        new Error(
          'Local settings were left in place and cannot be changed until the app restarts.',
        ),
      );
    }
    const write = this.writes.then(async () => {
      const candidate = modelId === undefined ? this.value : { ...this.value, modelId };
      const contents = serializeLocalPreferences(candidate, this.legacyDrafts);
      try {
        await this.storage.writeRuntimeDocument(PREFERENCES_DOCUMENT, contents);
      } catch (error) {
        this.dirty = true;
        this.failureValue =
          error instanceof Error ? error : new Error('Local settings could not be saved.');
        this.changed('persistence');
        throw error;
      }
      if (modelId !== undefined) {
        this.update({ modelId });
      }
      this.dirty = contents !== serializeLocalPreferences(this.value, this.legacyDrafts);
      if (!this.dirty && this.failureValue) {
        this.failureValue = null;
        this.changed('persistence');
      }
    });
    this.writes = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  /** Writes only unsaved or previously failed changes; never overwrites settings left in place. */
  async flush(): Promise<void> {
    await this.writes;
    if (this.loaded && (this.dirty || this.failureValue)) {
      await this.save();
    }
  }
}
