import type { LocalPreferences, LocalPreferencesStore } from './preferences';
import {
  mergeCatalogs,
  message,
  NO_COMMANDS,
  PROJECT_SKILL_ROOTS,
  scanSkillSource,
  SKILL_FILE_LIST_LIMIT,
  SKILL_PAGE_BYTES,
  skillCommand,
  textPage,
  unreadable,
  validSkillId,
  validSkillName,
  walkBundle,
  type LocalSkill,
  type LocalSkillCatalog,
  type LocalSkillCommand,
  type LocalSkillImport,
  type LocalSkillListing,
  type LocalSkillPage,
  type LocalSkillPort,
  type LocalSkippedSkillFile,
  type PartialCatalog,
} from './skillCatalog';
import {
  catalogUrl,
  loadSkillConfig,
  SKILL_RULE_LIMIT,
  skillPermission,
  validSkillRule,
  type LocalSkillAgent,
  type LocalSkillConfig,
  type LocalSkillPermission,
  type LocalSkillRule,
  type LocalSkillSourcedRule,
} from './skillConfig';
import {
  cachedCatalog,
  DEFAULT_SKILL_WEB,
  downloadSkillCatalog,
  importPersonalSkill,
  personalCatalog,
  personalDocument,
  removeCachedCatalog,
  storedSkill,
  type LocalSkillCatalogDownload,
  type LocalSkillCatalogStatus,
  type LocalSkillWeb,
} from './skillStore';
import { LocalToolInputError } from './toolArguments';
import { safeWorkspacePath } from './workspaceGuidance';

export {
  PROJECT_SKILL_ROOTS,
  SKILL_PAGE_BYTES,
  SKILLS_PER_ROOT,
  type LocalSkill,
  type LocalSkillCatalog,
  type LocalSkillCommand,
  type LocalSkillDiagnostic,
  type LocalSkillImport,
  type LocalSkillListEntry,
  type LocalSkillListing,
  type LocalSkillPage,
  type LocalSkillSourceKind,
  type LocalSkippedSkillFile,
} from './skillCatalog';
export type {
  LocalSkillAgent,
  LocalSkillEffect,
  LocalSkillPermission,
  LocalSkillRule,
  LocalSkillSourcedRule,
} from './skillConfig';
export type {
  LocalSkillCatalogDownload,
  LocalSkillCatalogDownloadResult,
  LocalSkillCatalogStatus,
} from './skillStore';

type SkillSettings = Pick<LocalPreferencesStore, 'get' | 'update' | 'save'>;
type RemoteCatalog = Awaited<ReturnType<typeof cachedCatalog>>;

interface ProjectSkills {
  config: LocalSkillConfig;
  roots: Map<string, PartialCatalog>;
}

const PERSONAL_CATALOG_LIMIT = 16;
const EMPTY: PartialCatalog = { skills: [], diagnostics: [] };

/**
 * The union of GitHub Copilot and OpenCode skills. Sources, highest precedence first: explicit
 * `opencode.json` sources (paths and cached HTTPS catalogs), `.opencode`, `.github`, `.agents`,
 * `.claude`, personal catalogs, then imported personal skills. Project scans and config are
 * cached per workspace by the native change token; stored skills are reloaded after each
 * import, removal, or download. User rules, catalogs, and the global switch live in preferences.
 */
export class LocalSkills {
  private readonly projects = new Map<string, { token: string; value: Promise<ProjectSkills> }>();
  private readonly latest = new Map<string, LocalSkillCatalog>();
  private readonly commandLists = new Map<string, readonly LocalSkillCommand[]>();
  private readonly refreshing = new Set<string>();
  private readonly remote = new Map<string, Promise<RemoteCatalog>>();
  private readonly catalogErrors = new Map<string, string>();
  private personal: Promise<PartialCatalog> | null = null;
  private storeWrites: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly native: LocalSkillPort,
    private readonly settings: SkillSettings | null = null,
    private readonly changed: () => void = () => undefined,
    private readonly web: LocalSkillWeb = DEFAULT_SKILL_WEB,
  ) {}

  /** False when the device owner turned every skill off. */
  skillsEnabled(): boolean {
    return this.settings?.get().skillsEnabled !== false;
  }

  setSkillsEnabled(enabled: boolean): Promise<void> {
    return this.saveSettings({ skillsEnabled: enabled });
  }

  /** The device owner's ordered `skill` rules (the per-skill switches are separate). */
  rules(): readonly LocalSkillRule[] {
    return this.settings?.get().skillRules ?? [];
  }

  setRules(rules: readonly LocalSkillRule[]): Promise<void> {
    if (rules.length > SKILL_RULE_LIMIT || !rules.every(validSkillRule)) {
      return Promise.reject(
        new Error(`Use at most ${String(SKILL_RULE_LIMIT)} rules of 1-128 characters each.`),
      );
    }
    return this.saveSettings({
      skillRules: rules.map(({ pattern, effect }) => ({ pattern, effect })),
    });
  }

  /** Not denied by the device owner's own rules or switch (project rules may still deny it). */
  enabled(name: string): boolean {
    return skillPermission(this.userRules(), name).effect !== 'deny';
  }

  /** Project rules, then the agent's project rules, then the device owner's; last match wins. */
  permission(
    catalog: LocalSkillCatalog,
    name: string,
    agent: LocalSkillAgent = 'build',
  ): LocalSkillPermission {
    const { rules, agents } = catalog.config;
    return skillPermission([...rules, ...agents[agent].rules, ...this.userRules()], name);
  }

  /** The skill tool and its catalog exist for this agent (`tools.skill`, global switch). */
  toolEnabled(catalog: LocalSkillCatalog, agent: LocalSkillAgent = 'build'): boolean {
    return this.skillsEnabled() && !catalog.config.agents[agent].toolDisabled;
  }

  /** Listed for the model: described, auto-invocable, not denied, and the tool is on. */
  advertised(catalog: LocalSkillCatalog, skill: LocalSkill, agent: LocalSkillAgent = 'build') {
    return (
      this.toolEnabled(catalog, agent) &&
      Boolean(skill.description) &&
      skill.modelInvocable &&
      this.permission(catalog, skill.name, agent).effect !== 'deny'
    );
  }

  /** The user may activate it in the conversation with `/id` or `@id`. */
  userInvocable(catalog: LocalSkillCatalog, skill: LocalSkill): boolean {
    return (
      this.toolEnabled(catalog) &&
      skill.userInvocable &&
      this.permission(catalog, skill.name).effect !== 'deny'
    );
  }

  /** The catalog last loaded for a workspace, for synchronous approval decisions. */
  cached(workspace: string): LocalSkillCatalog | null {
    return this.latest.get(workspace) ?? null;
  }

  async catalog(workspace: string): Promise<LocalSkillCatalog> {
    const project = await this.project(workspace);
    this.personal ??= personalCatalog(this.native);
    const seen = new Set<string>();
    const sources = [
      ...[...project.config.sources].reverse(),
      ...PROJECT_SKILL_ROOTS.map((root) => ({ kind: 'path' as const, root })),
      ...[...(this.settings?.get().skillCatalogs ?? [])]
        .reverse()
        .map((url) => ({ kind: 'personal' as const, url })),
    ].filter((source) => {
      const key = source.kind === 'path' ? source.root : `${source.kind} ${source.url}`;
      return !seen.has(key) && seen.add(key);
    });
    const parts = await Promise.all([
      ...sources.map((source) =>
        source.kind === 'path'
          ? (project.roots.get(source.root) ?? EMPTY)
          : this.remoteCatalog(source.url, source.kind === 'personal' ? 'personal' : 'project'),
      ),
      this.personal,
    ]);
    const merged = mergeCatalogs(parts);
    const problems = project.config.problems.map((problem) => ({
      source: 'project' as const,
      ...problem,
      severity: 'warning' as const,
    }));
    const catalog = {
      ...merged,
      diagnostics: [...problems, ...merged.diagnostics],
      config: project.config,
    };
    this.latest.set(workspace, catalog);
    this.publishCommands(workspace, catalog);
    return catalog;
  }

  /** Every skill for Settings with its effective permission, plus diagnostics. */
  async list(workspace: string): Promise<LocalSkillListing> {
    const catalog = await this.catalog(workspace);
    return {
      skills: catalog.skills.map((skill) => {
        const permission = this.permission(catalog, skill.name);
        return {
          ...skill,
          id: skill.name,
          enabled: permission.effect !== 'deny',
          permission,
          advertised: this.advertised(catalog, skill),
        };
      }),
      diagnostics: catalog.diagnostics,
    };
  }

  /**
   * Cached slash commands (user-invocable, permitted, slash-representable IDs). Snapshot
   * projection is synchronous, so this refreshes in the background and the `skills` slice
   * announces a changed list.
   */
  commands(workspace: string, refresh = false): readonly LocalSkillCommand[] {
    const cached = this.commandLists.get(workspace);
    if (refresh || (!cached && !this.refreshing.has(workspace))) {
      this.refreshing.add(workspace);
      void this.catalog(workspace)
        .catch(() => undefined)
        .finally(() => this.refreshing.delete(workspace));
    }
    return cached ?? NO_COMMANDS;
  }

  /**
   * Copilot CLI `/skills` enable/disable as device-owner rules: off adds a final `deny`; on
   * removes it and adds an exact `allow` only when the user's own rules still deny the ID.
   */
  setEnabled(name: string, enabled: boolean): Promise<void> {
    if (!this.settings || !validSkillId(name)) {
      return Promise.reject(new Error('Choose a skill to enable or disable.'));
    }
    const value = this.settings.get();
    const disabled = new Set(value.disabledSkills);
    const patch: Partial<LocalPreferences> = {};
    if (enabled) {
      disabled.delete(name);
      const rules = value.skillRules ?? [];
      if (skillPermission(sourced(rules, 'user'), name).effect === 'deny') {
        patch.skillRules = [...rules, { pattern: name, effect: 'allow' }];
      }
    } else {
      disabled.add(name);
    }
    return this.saveSettings({ ...patch, disabledSkills: [...disabled].sort() });
  }

  /** Copies SKILL.md and bundled UTF-8 files from a workspace skill directory; replaces by ID. */
  importPersonal(workspace: string, directory: string): Promise<LocalSkillImport> {
    return this.storeChange(() =>
      importPersonalSkill(this.native, workspace, safeWorkspacePath(directory)),
    );
  }

  removePersonal(name: string): Promise<void> {
    return this.storeChange(async () => {
      if (!validSkillName(name)) {
        throw new Error('Choose a personal skill to remove.');
      }
      await this.native.removeRuntimeDocument(personalDocument(name));
    });
  }

  /** Catalogs listed by the workspace's `opencode.json` (when given) and personal ones. */
  async catalogs(workspaceId: string | null): Promise<LocalSkillCatalogStatus[]> {
    const project = workspaceId ? (await this.project(workspaceId)).config.sources : [];
    const entries = [
      ...project.flatMap((source) =>
        source.kind === 'catalog'
          ? [{ url: source.url, scope: 'project' as const, file: source.file }]
          : [],
      ),
      ...(this.settings?.get().skillCatalogs ?? []).map((url) => ({
        url,
        scope: 'personal' as const,
        file: null,
      })),
    ];
    return Promise.all(
      entries.map(async (entry) => {
        const cached = await this.remoteCatalog(entry.url, entry.scope);
        const error = this.catalogErrors.get(entry.url) ?? null;
        const state = error ? 'failed' : cached.versions.length ? 'cached' : 'not-downloaded';
        return { ...entry, state, skills: cached.versions, error };
      }),
    );
  }

  /** Adds a personal HTTPS catalog (OpenCode global `skills` URL); it is not downloaded yet. */
  async addPersonalCatalog(url: string): Promise<string> {
    const base = catalogUrl(url);
    const current = this.settings?.get().skillCatalogs ?? [];
    if (!this.settings || current.length >= PERSONAL_CATALOG_LIMIT) {
      throw new Error(`At most ${String(PERSONAL_CATALOG_LIMIT)} personal catalogs can be added.`);
    }
    if (!current.includes(base)) {
      await this.saveSettings({ skillCatalogs: [...current, base] });
    }
    return base;
  }

  /** Removes a personal catalog and every cached copy of its skills. */
  removePersonalCatalog(url: string): Promise<void> {
    const base = catalogUrl(url);
    return this.storeChange(async () => {
      this.catalogErrors.delete(base);
      const current = this.settings?.get().skillCatalogs ?? [];
      await this.saveSettings({ skillCatalogs: current.filter((entry) => entry !== base) });
      await removeCachedCatalog(this.native, base);
    });
  }

  /**
   * Downloads or updates a configured catalog: the only network use by skills, and only on this
   * explicit call (Settings), never by the agent. `workspaceId` null means a personal catalog.
   */
  async downloadCatalog(
    workspaceId: string | null,
    url: string,
  ): Promise<LocalSkillCatalogDownload> {
    const base = catalogUrl(url);
    const listed = (await this.catalogs(workspaceId)).some(
      (entry) => entry.url === base && (entry.scope === 'personal') === (workspaceId === null),
    );
    if (!listed) {
      throw new Error('Add this catalog in Settings or the workspace opencode.json first.');
    }
    return this.storeChange(async () => {
      try {
        const result = await downloadSkillCatalog(this.native, this.web, base);
        const failed = result.skills.find((skill) => skill.status === 'failed');
        if (failed) {
          this.catalogErrors.set(base, `${failed.name}: ${failed.error ?? 'failed'}`);
        } else {
          this.catalogErrors.delete(base);
        }
        return result;
      } catch (error) {
        this.catalogErrors.set(base, message(error));
        throw error;
      }
    });
  }

  /** One UTF-8 page of SKILL.md or a bundled file; `nextOffset` is opaque, pass it back as is. */
  async read(
    workspace: string,
    skill: LocalSkill,
    resource: string,
    offset: number,
  ): Promise<LocalSkillPage> {
    const path = safeWorkspacePath(resource);
    if (skill.sourceKind === 'project-root' || skill.sourceKind === 'config-path') {
      if (skill.layout === 'flat' && path !== 'SKILL.md') {
        throw new LocalToolInputError(`${path}: a flat skill file has no bundled files.`);
      }
      const file = skill.layout === 'flat' ? skill.location : `${skill.location}/${path}`;
      const page = await this.native
        .readWorkspaceFile(workspace, file, offset, SKILL_PAGE_BYTES)
        .catch((error: unknown) => {
          throw unreadable(error, path);
        });
      return { content: page.content, offset, nextOffset: page.nextOffset };
    }
    const stored = await storedSkill(this.native, skill);
    if (!Object.hasOwn(stored.files, path)) {
      const skipped = stored.skipped.find((entry) => entry.path === path);
      throw new LocalToolInputError(
        skipped
          ? `${path} was not imported: ${skipped.reason}`
          : `${path} is not a file in this skill.`,
      );
    }
    return textPage(stored.files[path] ?? '', offset);
  }

  /** Bundled file paths relative to the skill directory (SKILL.md excluded). */
  async files(
    workspace: string,
    skill: LocalSkill,
  ): Promise<{ files: string[]; filesTruncated: boolean; skippedFiles: LocalSkippedSkillFile[] }> {
    if (skill.sourceKind === 'personal' || skill.sourceKind === 'catalog') {
      const stored = await storedSkill(this.native, skill);
      const files = Object.keys(stored.files).filter((path) => path !== 'SKILL.md');
      return {
        files: files.slice(0, SKILL_FILE_LIST_LIMIT),
        filesTruncated: files.length > SKILL_FILE_LIST_LIMIT,
        skippedFiles: stored.skipped.slice(0, SKILL_FILE_LIST_LIMIT),
      };
    }
    if (skill.layout === 'flat') {
      return { files: [], filesTruncated: false, skippedFiles: [] };
    }
    const walk = await walkBundle(this.native, workspace, skill.location, SKILL_FILE_LIST_LIMIT);
    return {
      files: walk.files.map((file) => file.path),
      filesTruncated: walk.truncated,
      skippedFiles: walk.skipped.slice(0, SKILL_FILE_LIST_LIMIT),
    };
  }

  private userRules(): LocalSkillSourcedRule[] {
    const value = this.settings?.get();
    const disabled = (value?.disabledSkills ?? []).map((pattern) => ({
      pattern,
      effect: 'deny' as const,
    }));
    return sourced([...(value?.skillRules ?? []), ...disabled], 'user');
  }

  /** Project config and root scans, cached per workspace by the native change token. */
  private async project(workspace: string): Promise<ProjectSkills> {
    // ponytail: any workspace change rescans every source (bounded per root and directory count).
    const token = await this.native.getWorkspaceChangeToken(workspace);
    let entry = this.projects.get(workspace);
    if (entry?.token !== token) {
      entry = { token, value: this.loadProject(workspace) };
      this.projects.set(workspace, entry);
    }
    return entry.value;
  }

  private async loadProject(workspace: string): Promise<ProjectSkills> {
    const config = await loadSkillConfig(this.native, workspace);
    const configured = config.sources.flatMap((source) =>
      source.kind === 'path' ? [source.root] : [],
    );
    const roots = [...new Set([...configured, ...PROJECT_SKILL_ROOTS])];
    const scans = await Promise.all(
      roots.map((root) =>
        scanSkillSource(
          this.native,
          workspace,
          root,
          PROJECT_SKILL_ROOTS.includes(root) ? 'project-root' : 'config-path',
        ),
      ),
    );
    return { config, roots: new Map(roots.map((root, index) => [root, scans[index] ?? EMPTY])) };
  }

  private remoteCatalog(url: string, source: LocalSkill['source']): Promise<RemoteCatalog> {
    const key = `${source} ${url}`;
    let value = this.remote.get(key);
    if (!value) {
      value = cachedCatalog(this.native, url, source).catch((error: unknown) => ({
        skills: [],
        versions: [],
        diagnostics: [
          { source, location: url, message: message(error), severity: 'skipped' as const },
        ],
      }));
      this.remote.set(key, value);
    }
    return value;
  }

  /** Serializes stored-skill changes, then reloads stored skills and announces new commands. */
  private storeChange<T>(work: () => Promise<T>): Promise<T> {
    const result = this.storeWrites.then(work).finally(() => {
      this.personal = null;
      this.remote.clear();
      this.changed();
      for (const workspace of this.commandLists.keys()) {
        this.commands(workspace, true);
      }
    });
    this.storeWrites = result.catch(() => undefined);
    return result;
  }

  private async saveSettings(patch: Partial<LocalPreferences>): Promise<void> {
    if (!this.settings) {
      throw new Error('Skill settings are unavailable.');
    }
    this.settings.update(patch);
    this.changed();
    for (const [workspace, catalog] of this.latest) {
      this.publishCommands(workspace, catalog);
    }
    await this.settings.save();
  }

  private publishCommands(workspace: string, catalog: LocalSkillCatalog): void {
    const next = catalog.skills
      .filter((skill) => validSkillName(skill.name) && this.userInvocable(catalog, skill))
      .map(skillCommand);
    const previous = this.commandLists.get(workspace);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(next)) {
      this.commandLists.set(workspace, next);
      this.changed();
    }
  }
}

function sourced(rules: readonly LocalSkillRule[], origin: string): LocalSkillSourcedRule[] {
  return rules.map((rule) => ({ ...rule, origin }));
}
