import { isRecord } from '@shared/records';
import { parseDocument, visit } from 'yaml';
import { isOnDeviceNativeError } from '../native/services.errors';
import type { OnDeviceNativeServices } from '../native/services.types';
import { joinWorkspacePath, type LocalDirectoryListing } from '../workspaces/types';
import { LocalToolInputError } from './toolArguments';
import type { LocalSkillConfig, LocalSkillPermission } from './skillConfig';
import { utf8Bytes } from './threadJournal';

export type LocalSkillPort = Pick<
  OnDeviceNativeServices,
  | 'getWorkspaceChangeToken'
  | 'listWorkspaceFiles'
  | 'readWorkspaceFile'
  | 'readRuntimeDocument'
  | 'writeRuntimeDocument'
  | 'listRuntimeDocuments'
  | 'removeRuntimeDocument'
>;

/** Project roots, highest precedence first (after explicit `opencode.json` sources). */
export const PROJECT_SKILL_ROOTS = [
  '.opencode/skills',
  '.github/skills',
  '.agents/skills',
  '.claude/skills',
];
export const SKILLS_PER_ROOT = 128;
export const SKILL_FRONTMATTER_BYTES = 8192;
export const SKILL_PAGE_BYTES = 8192;
export const SKILL_FILE_LIST_LIMIT = 64;
export const PERSONAL_SKILL_BYTES = 4 * 1024 * 1024;
const ROOT_ENTRIES = 1000;
const BUNDLE_DEPTH = 6;
const BUNDLE_DIRECTORIES = 64;
/** OpenCode stops searching six directories below a source root. */
const SOURCE_DEPTH = 6;
const SOURCE_DIRECTORIES = 256;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SKILL_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u;

export type LocalSkillSourceKind = 'project-root' | 'config-path' | 'catalog' | 'personal';

export interface LocalSkill {
  /** The path-derived ID (directory holding SKILL.md, or a flat file's stem); case-sensitive. */
  name: string;
  /** Frontmatter `name` when present (OpenCode display name), else the ID. */
  displayName: string;
  /** Empty when absent: the skill is registered but never advertised to the model. */
  description: string;
  source: 'project' | 'personal';
  /** A project root, an `opencode.json` path, an HTTPS catalog, or an imported personal skill. */
  sourceKind: LocalSkillSourceKind;
  /** The root path, configured path, catalog URL, or `personal`. */
  sourceRoot: string;
  /** `flat` is a root-level `<id>.md` with no bundled files. */
  layout: 'directory' | 'flat';
  /** Skill directory or flat file, `personal/<id>`, or the catalog skill URL. */
  location: string;
  argumentHint: string | null;
  userInvocable: boolean;
  /** `opencode/autoinvoke`, else not `disable-model-invocation`: false hides it from the model. */
  modelInvocable: boolean;
  context: 'inline' | 'fork';
  allowedTools: readonly string[];
  license: string | null;
  compatibility: string | null;
}

/** A skipped or shadowed skill, or a warning about a registered one (shown in Settings). */
export interface LocalSkillDiagnostic {
  source: 'project' | 'personal';
  location: string;
  message: string;
  severity: 'skipped' | 'warning';
}

export interface LocalSkillCatalog {
  skills: readonly LocalSkill[];
  diagnostics: readonly LocalSkillDiagnostic[];
  config: LocalSkillConfig;
}

/** A listed skill as the conversation (`build` agent) sees it in this workspace. */
export interface LocalSkillListEntry extends LocalSkill {
  /** Same as `name`: the exact ID used by `/id`, `@id`, rules, and the skill tool. */
  id: string;
  /** False when the effective permission is `deny`. */
  enabled: boolean;
  permission: LocalSkillPermission;
  /** Listed in the model's prompt: has a description, auto-invocable, permitted, skills on. */
  advertised: boolean;
}

export interface LocalSkillListing {
  skills: readonly LocalSkillListEntry[];
  diagnostics: readonly LocalSkillDiagnostic[];
}

/** A slash command entry for the ACP snapshot and `dappercode.dev/commands` event. */
export interface LocalSkillCommand {
  name: string;
  description: string;
  hint?: string;
}

export interface LocalSkippedSkillFile {
  path: string;
  reason: string;
}

export interface LocalSkillImport {
  name: string;
  files: readonly string[];
  skipped: readonly LocalSkippedSkillFile[];
}

export interface LocalSkillPage {
  content: string;
  offset: number;
  nextOffset: number | null;
}

type SkillMetadata = Omit<
  LocalSkill,
  'source' | 'sourceKind' | 'sourceRoot' | 'layout' | 'location'
>;
export const NO_COMMANDS: readonly LocalSkillCommand[] = [];

class SkillDefinitionError extends Error {}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The skill could not be read.';
}

/** Copilot's portable name: the only IDs that can be slash commands or personal imports. */
export function validSkillName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= 64 && SKILL_NAME.test(name);
}

/** Any path-derived ID OpenCode accepts that is safe to name: 1-64 of `A-Z a-z 0-9 . _ -`. */
export function validSkillId(id: unknown): id is string {
  return typeof id === 'string' && SKILL_ID.test(id);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** All frontmatter is optional (OpenCode); a file without `---` has none. */
function frontmatter(text: string): Record<string, unknown> {
  if (!/^\uFEFF?---\r?\n/u.test(text)) {
    return {};
  }
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) {
    throw new SkillDefinitionError(
      `expected YAML frontmatter between --- lines within the first ${String(SKILL_FRONTMATTER_BYTES)} bytes.`,
    );
  }
  const document = parseDocument(match[1] ?? '', { schema: 'core', uniqueKeys: true });
  if (document.errors.length || document.warnings.length) {
    throw new SkillDefinitionError(
      'invalid YAML frontmatter (including duplicate keys or unsupported tags).',
    );
  }
  visit(document, {
    Alias() {
      throw new SkillDefinitionError('YAML aliases are not supported.');
    },
  });
  const metadata: unknown = document.toJS({ maxAliasCount: 0 });
  if (!isRecord(metadata)) {
    throw new SkillDefinitionError('frontmatter must be a mapping.');
  }
  const extra = metadata['metadata'];
  if (
    extra !== undefined &&
    (!isRecord(extra) ||
      Object.values(extra).some((value) => !['string', 'boolean', 'number'].includes(typeof value)))
  ) {
    throw new SkillDefinitionError('metadata must map keys to text, true/false, or numbers.');
  }
  return metadata;
}

function optionalText(
  metadata: Record<string, unknown>,
  key: string,
  limit: number,
): string | null {
  const value = metadata[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new SkillDefinitionError(
      `${key} must be non-empty text of at most ${String(limit)} characters.`,
    );
  }
  return value.trim();
}

function optionalFlag(metadata: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = metadata[key];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new SkillDefinitionError(`${key} must be true or false.`);
  }
  return value;
}

/** `argument-hint: [file]` is a YAML list; it is shown as written rather than rejected. */
function argumentHint(value: unknown): string | null {
  const parts = Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' || typeof entry === 'number')
    : null;
  const hint = parts ? `[${parts.join(', ')}]` : typeof value === 'string' ? value : '';
  return hint.trim() || null;
}

function allowedTools(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const entries: unknown[] = Array.isArray(value) ? value : [value];
  if (!entries.every((entry): entry is string => typeof entry === 'string')) {
    throw new SkillDefinitionError(
      'allowed-tools must be a space-separated string or a list of tool names.',
    );
  }
  return entries.flatMap((entry) => entry.match(/[^\s,()]+(?:\([^)]*\))?/gu) ?? []);
}

/** `metadata.opencode/autoinvoke`; when set it wins over `disable-model-invocation`. */
function autoInvoke(metadata: Record<string, unknown>): boolean | null {
  const value = isRecord(metadata['metadata']) ? metadata['metadata']['opencode/autoinvoke'] : null;
  if (value === undefined || value === null) {
    return null;
  }
  if (value !== true && value !== false && value !== 'true' && value !== 'false') {
    throw new SkillDefinitionError('metadata opencode/autoinvoke must be true or false.');
  }
  return value === true || value === 'true';
}

/**
 * Agent Skills frontmatter via the existing YAML parser, as the union of Copilot and OpenCode:
 * every field is optional, a `name` other than the ID is a display name, and `warn` receives
 * portability notes. Unknown fields are ignored; malformed known fields still skip the skill.
 */
export function parseSkillDefinition(
  text: string,
  id: string,
  warn: (detail: string) => void = () => undefined,
): SkillMetadata {
  const metadata = frontmatter(text);
  const name = optionalText(metadata, 'name', 1024);
  if (name !== id || !validSkillName(id)) {
    warn(
      'Portability: GitHub Copilot needs a lowercase kebab-case directory name matching frontmatter name, and skips this skill.',
    );
  }
  const raw = metadata['description'] ?? '';
  if (typeof raw !== 'string') {
    throw new SkillDefinitionError('description must be text.');
  }
  const description = raw.replace(/\s+/gu, ' ').trim();
  if (!description) {
    warn('No description: available by ID, but never advertised to the model.');
  } else if (raw.length > 1024) {
    warn('Portability: GitHub Copilot skips descriptions longer than 1024 characters.');
  }
  const context = metadata['context'] ?? 'inline';
  if (context !== 'inline' && context !== 'fork') {
    throw new SkillDefinitionError('context must be fork when present.');
  }
  return {
    name: id,
    displayName: name ?? id,
    description,
    argumentHint: argumentHint(metadata['argument-hint']),
    userInvocable: optionalFlag(metadata, 'user-invocable', true),
    modelInvocable:
      autoInvoke(metadata) ?? !optionalFlag(metadata, 'disable-model-invocation', false),
    context,
    allowedTools: allowedTools(metadata['allowed-tools']),
    license: optionalText(metadata, 'license', 1024),
    compatibility: optionalText(metadata, 'compatibility', 500),
  };
}

export interface PartialCatalog {
  skills: LocalSkill[];
  diagnostics: LocalSkillDiagnostic[];
}

interface SourceScan {
  native: LocalSkillPort;
  workspace: string;
  root: string;
  kind: 'project-root' | 'config-path';
  catalog: PartialCatalog;
}

function report(
  scan: SourceScan,
  location: string,
  detail: string,
  severity: LocalSkillDiagnostic['severity'] = 'skipped',
): void {
  scan.catalog.diagnostics.push({ source: 'project', location, message: detail, severity });
}

/** Sorted visible entries; hidden entries and node_modules are skipped, links are reported. */
async function listSource(
  scan: SourceScan,
  path: string,
  required = false,
): Promise<LocalDirectoryListing['entries'] | null> {
  let listing: LocalDirectoryListing;
  try {
    listing = await scan.native.listWorkspaceFiles(scan.workspace, path, ROOT_ENTRIES);
  } catch (error) {
    if (required || !isOnDeviceNativeError(error, 'PATH_NOT_FOUND')) {
      report(scan, path || '.', message(error));
    }
    return null;
  }
  if (listing.truncated) {
    // Native enumeration bounds before sorting; never advertise a nondeterministic subset.
    report(scan, path || '.', `Skipped: more than ${String(ROOT_ENTRIES)} entries.`);
    return null;
  }
  return [...listing.entries].sort(byName).filter((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      return false;
    }
    if (entry.kind === 'symlink' || entry.kind === 'other') {
      report(
        scan,
        joinWorkspacePath(path, entry.name),
        'Skipped: discovery does not follow links.',
      );
    }
    return entry.kind === 'file' || entry.kind === 'directory';
  });
}

/** Reads a bounded prefix of `<dir>/SKILL.md` or a flat `<id>.md`; the rest is paged on demand. */
async function scanSkill(
  scan: SourceScan,
  location: string,
  layout: LocalSkill['layout'],
): Promise<LocalSkill | 'missing' | null> {
  const base = location.split('/').at(-1) ?? '';
  const id = layout === 'flat' ? base.slice(0, -'.md'.length) : base;
  try {
    const file = layout === 'flat' ? location : `${location}/SKILL.md`;
    const read = await scan.native.readWorkspaceFile(
      scan.workspace,
      file,
      0,
      SKILL_FRONTMATTER_BYTES,
    );
    if (!validSkillId(id)) {
      throw new SkillDefinitionError('IDs are 1-64 letters, digits, ".", "_" or "-".');
    }
    const warn = (detail: string) => report(scan, location, detail, 'warning');
    return {
      ...parseSkillDefinition(read.content, id, warn),
      source: 'project',
      sourceKind: scan.kind,
      sourceRoot: scan.root,
      layout,
      location,
    };
  } catch (error) {
    if (isOnDeviceNativeError(error, 'PATH_NOT_FOUND')) {
      return 'missing';
    }
    report(scan, location, message(error));
    return null;
  }
}

/**
 * OpenCode source layout: root-level `<id>.md` files, plus `SKILL.md` directories nested in
 * grouping directories up to six levels deep. A skill directory is a leaf. One bad skill or
 * source becomes a diagnostic; it never fails a turn or hides other skills.
 */
export async function scanSkillSource(
  native: LocalSkillPort,
  workspace: string,
  root: string,
  kind: SourceScan['kind'],
): Promise<PartialCatalog> {
  const scan: SourceScan = {
    native,
    workspace,
    root,
    kind,
    catalog: { skills: [], diagnostics: [] },
  };
  const top = await listSource(scan, root, kind === 'config-path');
  const flat = (top ?? []).filter((entry) => entry.kind === 'file' && /.\.md$/u.test(entry.name));
  const found = (
    await Promise.all(
      flat.map((entry) => scanSkill(scan, joinWorkspacePath(root, entry.name), 'flat')),
    )
  ).filter((skill): skill is LocalSkill => typeof skill === 'object' && skill !== null);
  let level = (top ?? [])
    .filter((entry) => entry.kind === 'directory')
    .map((entry) => joinWorkspacePath(root, entry.name));
  for (let depth = 1, visited = 0; level.length > 0 && found.length < SKILLS_PER_ROOT; depth += 1) {
    if (visited + level.length > SOURCE_DIRECTORIES) {
      report(scan, root || '.', `Stopped after ${String(SOURCE_DIRECTORIES)} directories.`);
      level = level.slice(0, SOURCE_DIRECTORIES - visited);
    }
    visited += level.length;
    const results = await Promise.all(
      level.map(async (path) => {
        const skill = await scanSkill(scan, path, 'directory');
        const entries =
          skill === 'missing' && depth < SOURCE_DEPTH ? await listSource(scan, path) : null;
        return {
          skill,
          children: (entries ?? [])
            .filter((entry) => entry.kind === 'directory')
            .map((entry) => joinWorkspacePath(path, entry.name)),
        };
      }),
    );
    found.push(
      ...results.flatMap(({ skill }) => (typeof skill === 'object' && skill ? [skill] : [])),
    );
    level = results.flatMap((result) => result.children);
  }
  if (found.length > SKILLS_PER_ROOT) {
    const extra = found.length - SKILLS_PER_ROOT;
    report(
      scan,
      root || '.',
      `Skipped ${String(extra)} skills beyond ${String(SKILLS_PER_ROOT)} per root.`,
    );
  }
  scan.catalog.skills.push(...found.slice(0, SKILLS_PER_ROOT));
  return scan.catalog;
}

/** The first catalog in precedence order wins an ID; later ones are reported as shadowed. */
export function mergeCatalogs(parts: readonly PartialCatalog[]): Omit<LocalSkillCatalog, 'config'> {
  const seen = new Map<string, LocalSkill>();
  const diagnostics = parts.flatMap((part) => part.diagnostics);
  for (const skill of parts.flatMap((part) => part.skills)) {
    const first = seen.get(skill.name);
    if (first) {
      diagnostics.push({
        source: skill.source,
        location: skill.location,
        message: `Shadowed by the ${first.source} skill ${first.location}.`,
        severity: 'skipped',
      });
    } else {
      seen.set(skill.name, skill);
    }
  }
  return { skills: [...seen.values()], diagnostics };
}

interface BundleWalk {
  files: { path: string; bytes: number }[];
  skipped: LocalSkippedSkillFile[];
  truncated: boolean;
}

function bundleEntry(
  walk: BundleWalk,
  pending: { path: string; depth: number }[],
  directory: { path: string; depth: number },
  entry: LocalDirectoryListing['entries'][number],
  limit: number,
): void {
  const path = joinWorkspacePath(directory.path, entry.name);
  if (entry.kind === 'directory') {
    if (directory.depth + 1 < BUNDLE_DEPTH) {
      pending.push({ path, depth: directory.depth + 1 });
    } else {
      walk.skipped.push({ path, reason: `Deeper than ${String(BUNDLE_DEPTH)} directories.` });
    }
  } else if (entry.kind !== 'file') {
    walk.skipped.push({ path, reason: 'Links and special files are not supported.' });
  } else if (path !== 'SKILL.md') {
    if (walk.files.length < limit) {
      walk.files.push({ path, bytes: entry.bytes });
    } else {
      walk.truncated = true;
    }
  }
}

/** Every bundled file, breadth-first and sorted, bounded by count, depth, and directories. */
export async function walkBundle(
  native: LocalSkillPort,
  workspace: string,
  root: string,
  limit: number,
): Promise<BundleWalk> {
  const walk: BundleWalk = { files: [], skipped: [], truncated: false };
  const pending = [{ path: '', depth: 0 }];
  for (let visited = 0; pending.length > 0; visited += 1) {
    const directory = pending.shift();
    if (!directory || visited === BUNDLE_DIRECTORIES) {
      walk.truncated = true;
      break;
    }
    try {
      const path = directory.path ? `${root}/${directory.path}` : root;
      const listing = await native.listWorkspaceFiles(workspace, path, Math.min(1000, limit + 1));
      walk.truncated ||= listing.truncated;
      for (const entry of [...listing.entries].sort(byName)) {
        bundleEntry(walk, pending, directory, entry, limit);
      }
    } catch (error) {
      walk.skipped.push({ path: directory.path || '.', reason: message(error) });
    }
  }
  return walk;
}

export function textPage(content: string, offset: number): LocalSkillPage {
  if (offset > content.length) {
    throw new LocalToolInputError('The offset is beyond the end of the file.');
  }
  let end = Math.min(content.length, offset + SKILL_PAGE_BYTES);
  const last = content.charCodeAt(end - 1);
  if (end < content.length && last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return {
    content: content.slice(offset, end),
    offset,
    nextOffset: end < content.length ? end : null,
  };
}

export function unreadable(error: unknown, path: string): unknown {
  if (isOnDeviceNativeError(error, 'FILE_NOT_TEXT')) {
    return new LocalToolInputError(`${path} is binary; only UTF-8 text skill files can be read.`);
  }
  if (isOnDeviceNativeError(error, 'PATH_NOT_FOUND')) {
    return new LocalToolInputError(`${path} is not a file in this skill.`);
  }
  return error;
}

function clipUtf8(value: string, limit: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    bytes += utf8Bytes(character);
    if (bytes > limit) {
      break;
    }
    end += character.length;
  }
  return value.slice(0, end);
}

/** Bounded like the Rust bridge's AG-UI commands: 256-byte hints, 2 KiB descriptions. */
export function skillCommand(skill: LocalSkill): LocalSkillCommand {
  const hint = clipUtf8(skill.argumentHint ?? '', 256).trim();
  return {
    name: skill.name,
    description: clipUtf8(skill.description || skill.displayName, 2048),
    ...(hint ? { hint } : {}),
  };
}
