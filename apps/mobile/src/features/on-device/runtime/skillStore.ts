import { isRecord } from '@shared/records';
import { isOnDeviceNativeError } from '../native/services.errors';
import {
  message,
  parseSkillDefinition,
  PERSONAL_SKILL_BYTES,
  validSkillName,
  walkBundle,
  type LocalSkill,
  type LocalSkillImport,
  type LocalSkillPort,
  type LocalSkippedSkillFile,
  type PartialCatalog,
} from './skillCatalog';
import { LocalToolInputError } from './toolArguments';
import { utf8Bytes } from './threadJournal';
import { requestWeb, webResponseText, withWebRequest, type WebRequest } from './webRequest';
import { safeWorkspacePath } from './workspaceGuidance';

/** Network access for catalog downloads; only an explicit Settings action ever uses it. */
export interface LocalSkillWeb {
  requireNetwork(action: string): void;
  request?: WebRequest;
  timeoutMs?: number;
}

export const DEFAULT_SKILL_WEB: LocalSkillWeb = { requireNetwork: () => undefined };

export interface LocalSkillCatalogStatus {
  url: string;
  /** `project`: listed by this workspace's `opencode.json`; `personal`: added in Settings. */
  scope: 'project' | 'personal';
  /** The config file that lists it, for project catalogs. */
  file: string | null;
  state: 'not-downloaded' | 'cached' | 'failed';
  /** Cached skill IDs and versions; the agent uses only these copies. */
  skills: readonly { name: string; version: string }[];
  /** The last download failure in this app session. */
  error: string | null;
}

export interface LocalSkillCatalogDownloadResult {
  name: string;
  version: string | null;
  status: 'downloaded' | 'unchanged' | 'failed';
  error?: string;
}

export interface LocalSkillCatalogDownload {
  url: string;
  skills: readonly LocalSkillCatalogDownloadResult[];
}

export const PERSONAL_SKILL_LIMIT = 64;
export const PERSONAL_SKILL_FILES = 128;
const DOCUMENT_BYTES = 8 * 1024 * 1024;
const PERSONAL_PREFIX = 'skill-';
const CATALOG_PREFIX = 'skillcat-';
const CATALOG_SKILLS = 64;
const CATALOG_FILES = 64;

export async function readWhole(
  native: LocalSkillPort,
  workspace: string,
  path: string,
  maximum: number,
): Promise<string> {
  let content = '';
  let revision: string | null = null;
  for (let offset: number | null = 0; offset !== null;) {
    const page = await native.readWorkspaceFile(workspace, path, offset, 65_536);
    if (page.totalBytes > maximum) {
      throw new Error(`${path} exceeds the ${String(maximum)}-byte personal skill limit.`);
    }
    if (revision !== null && page.revision !== revision) {
      throw new Error(`${path} changed while it was being read.`);
    }
    revision = page.revision;
    content += page.content;
    offset = page.nextOffset;
  }
  return content;
}

export function personalDocument(name: string): string {
  return `${PERSONAL_PREFIX}${name}.json`;
}

export interface StoredPersonalSkill {
  files: Record<string, string>;
  skipped: LocalSkippedSkillFile[];
}

export function parsePersonalSkill(raw: string, name: string): StoredPersonalSkill {
  const value: unknown = JSON.parse(raw);
  const files = isRecord(value) ? value['files'] : null;
  const skipped = isRecord(value) ? value['skipped'] : null;
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    value['name'] !== name ||
    !isRecord(files) ||
    !Object.hasOwn(files, 'SKILL.md') ||
    !Object.values(files).every((content) => typeof content === 'string') ||
    !Array.isArray(skipped)
  ) {
    throw new Error('The saved skill is damaged; import or download it again.');
  }
  return {
    files: files as Record<string, string>,
    skipped: skipped.filter(
      (entry): entry is LocalSkippedSkillFile =>
        isRecord(entry) && typeof entry['path'] === 'string' && typeof entry['reason'] === 'string',
    ),
  };
}

/** A stable document-name key per catalog URL (two FNV-1a passes; not a security boundary). */
function catalogKey(url: string): string {
  let low = 0x811c9dc5;
  let high = 0x01000193;
  for (let index = 0; index < url.length; index += 1) {
    low = Math.imul(low ^ url.charCodeAt(index), 0x01000193);
    high = Math.imul(high ^ url.charCodeAt(index), 0x5bd1e995);
  }
  return [low, high].map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

function catalogPrefix(url: string): string {
  return `${CATALOG_PREFIX}${catalogKey(url)}-`;
}

export function catalogDocument(url: string, name: string): string {
  return `${catalogPrefix(url)}${name}.json`;
}

interface CachedSkill {
  name: string;
  version: string;
  entry: string;
  files: Record<string, string>;
}

function parseCached(raw: string, url: string, name: string): CachedSkill {
  const stored = parsePersonalSkill(raw, name);
  const value: unknown = JSON.parse(raw);
  const version = isRecord(value) ? value['skillVersion'] : null;
  const entry = isRecord(value) ? value['entry'] : null;
  if (
    !isRecord(value) ||
    value['url'] !== url ||
    typeof version !== 'string' ||
    typeof entry !== 'string'
  ) {
    throw new Error('The cached catalog skill is damaged; download the catalog again.');
  }
  return { name, version, entry, files: stored.files };
}

function cachedVersion(raw: string, url: string, name: string): string | null {
  try {
    return parseCached(raw, url, name).version;
  } catch {
    return null;
  }
}

/** Cached skills of one catalog, as a source in the merged catalog. Never touches the network. */
export async function cachedCatalog(
  native: LocalSkillPort,
  url: string,
  source: LocalSkill['source'],
): Promise<PartialCatalog & { versions: { name: string; version: string }[] }> {
  const result: PartialCatalog & { versions: { name: string; version: string }[] } = {
    skills: [],
    diagnostics: [],
    versions: [],
  };
  const prefix = catalogPrefix(url);
  for (const document of (await native.listRuntimeDocuments(prefix)).sort()) {
    const name = document.slice(prefix.length, -'.json'.length);
    const location = `${url}${name}/`;
    const report = (detail: string, severity: 'skipped' | 'warning' = 'skipped') =>
      result.diagnostics.push({ source, location, message: detail, severity });
    try {
      const cached = parseCached((await native.readRuntimeDocument(document)) ?? '', url, name);
      result.versions.push({ name, version: cached.version });
      result.skills.push({
        ...parseSkillDefinition(cached.files['SKILL.md'] ?? '', name, (detail) =>
          report(detail, 'warning'),
        ),
        source,
        sourceKind: 'catalog',
        sourceRoot: url,
        layout: cached.entry === 'SKILL.md' ? 'directory' : 'flat',
        location,
      });
    } catch (error) {
      report(message(error));
    }
  }
  if (!result.versions.length) {
    result.diagnostics.push({
      source,
      location: url,
      message: 'Not downloaded: the agent never downloads catalogs; download it in Settings.',
      severity: 'warning',
    });
  }
  return result;
}

export function removeCachedCatalog(native: LocalSkillPort, url: string): Promise<unknown> {
  return native
    .listRuntimeDocuments(catalogPrefix(url))
    .then((documents) => Promise.all(documents.map((name) => native.removeRuntimeDocument(name))));
}

async function fetchText(web: LocalSkillWeb, url: string): Promise<string> {
  return withWebRequest(
    undefined,
    async (signal) => {
      const response = await (web.request ?? requestWeb)(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        headers: { Accept: 'application/json, text/*' },
        signal,
      });
      if (response.status !== 200) {
        const redirect = response.status >= 300 && response.status < 400;
        throw new Error(
          `${url} returned HTTP ${String(response.status)}${redirect ? '; catalog redirects are not followed' : ''}.`,
        );
      }
      let text = '';
      for await (const chunk of webResponseText(response)) {
        text += chunk;
      }
      return text;
    },
    web.timeoutMs,
  );
}

interface IndexEntry {
  name: string;
  version: string;
  files: string[];
  entry: string;
}

function catalogFiles(files: unknown): string[] {
  if (!Array.isArray(files) || files.length > CATALOG_FILES) {
    throw new Error(`Catalog skills list at most ${String(CATALOG_FILES)} file paths.`);
  }
  return files.map((file: unknown, index) => {
    if (typeof file !== 'string' || /[%?#:]/u.test(file) || files.indexOf(file) !== index) {
      throw new Error(`${String(file)}: catalog file paths must be unique, plain, and relative.`);
    }
    return safeWorkspacePath(file);
  });
}

/** Safe, relative, same-origin file paths and an entry file (`SKILL.md` or `<name>.md`). */
function indexEntry(value: unknown): IndexEntry {
  const entry = isRecord(value) ? value : {};
  const { name, version } = entry;
  if (!validSkillName(name)) {
    throw new Error(
      'Catalog skill names must be 1-64 lowercase letters/digits with single hyphens.',
    );
  }
  const text = typeof version === 'string' || typeof version === 'number' ? String(version) : '';
  if (!text || text.length > 64) {
    throw new Error('Catalog skills need a version of at most 64 characters.');
  }
  const files = catalogFiles(entry['files']);
  const main = ['SKILL.md', `${name}.md`].find((file) => files.includes(file));
  if (!main) {
    throw new Error(`The catalog must list SKILL.md or ${name}.md.`);
  }
  return { name, version: text, files, entry: main };
}

async function downloadSkill(
  native: LocalSkillPort,
  web: LocalSkillWeb,
  base: string,
  entry: IndexEntry,
): Promise<'downloaded' | 'unchanged'> {
  const document = catalogDocument(base, entry.name);
  const existing = await native.readRuntimeDocument(document);
  if (existing !== null && cachedVersion(existing, base, entry.name) === entry.version) {
    return 'unchanged';
  }
  const origin = new URL(base).origin;
  const files: Record<string, string> = {};
  let bytes = 0;
  for (const file of entry.files) {
    const directory = `${base}${entry.name}/`;
    const url = `${directory}${file.split('/').map(encodeURIComponent).join('/')}`;
    if (new URL(url).origin !== origin || !new URL(url).href.startsWith(directory)) {
      throw new Error(`${file}: catalog files must stay inside the catalog skill directory.`);
    }
    const content = await fetchText(web, url);
    bytes += utf8Bytes(content);
    if (bytes > PERSONAL_SKILL_BYTES) {
      throw new Error('The catalog skill exceeds the 4 MiB limit.');
    }
    files[file === entry.entry ? 'SKILL.md' : file] = content;
  }
  parseSkillDefinition(files['SKILL.md'] ?? '', entry.name);
  const raw = JSON.stringify({
    version: 1,
    name: entry.name,
    files,
    skipped: [],
    url: base,
    skillVersion: entry.version,
    entry: entry.entry,
  });
  if (utf8Bytes(raw) > DOCUMENT_BYTES) {
    throw new Error('The catalog skill is too large to save.');
  }
  await native.writeRuntimeDocument(document, raw);
  return 'downloaded';
}

/**
 * Downloads `<base>/index.json`, then `<base>/<name>/<file>` for each skill whose version
 * changed. Entries that left the index are removed from the cache. Per-skill failures keep the
 * previous cached copy.
 */
export async function downloadSkillCatalog(
  native: LocalSkillPort,
  web: LocalSkillWeb,
  base: string,
): Promise<LocalSkillCatalogDownload> {
  web.requireNetwork('download skill catalogs');
  const index: unknown = JSON.parse(await fetchText(web, `${base}index.json`));
  const entries = isRecord(index) ? index['skills'] : null;
  if (!Array.isArray(entries) || entries.length > CATALOG_SKILLS) {
    throw new Error(`index.json must list at most ${String(CATALOG_SKILLS)} skills.`);
  }
  const skills: LocalSkillCatalogDownloadResult[] = [];
  for (const value of entries) {
    const name = isRecord(value) && typeof value['name'] === 'string' ? value['name'] : '?';
    const version = isRecord(value) ? value['version'] : null;
    try {
      const entry = indexEntry(value);
      skills.push({
        name,
        version: entry.version,
        status: await downloadSkill(native, web, base, entry),
      });
    } catch (error) {
      skills.push({
        name,
        version:
          typeof version === 'string' || typeof version === 'number' ? String(version) : null,
        status: 'failed',
        error: message(error),
      });
    }
  }
  const listed = new Set(skills.map((skill) => catalogDocument(base, skill.name)));
  const stale = (await native.listRuntimeDocuments(catalogPrefix(base))).filter(
    (name) => !listed.has(name),
  );
  await Promise.all(stale.map((name) => native.removeRuntimeDocument(name)));
  return { url: base, skills };
}

export function storedDocument(skill: LocalSkill): string {
  return skill.sourceKind === 'catalog'
    ? catalogDocument(skill.sourceRoot, skill.name)
    : personalDocument(skill.name);
}

/** A personal or catalog skill's saved files. */
export async function storedSkill(
  native: LocalSkillPort,
  skill: LocalSkill,
): Promise<StoredPersonalSkill> {
  const raw = await native.readRuntimeDocument(storedDocument(skill));
  if (raw === null) {
    throw new LocalToolInputError(`The skill ${skill.name} was removed from this iPhone.`);
  }
  return parsePersonalSkill(raw, skill.name);
}

/** Imported personal skills, as the lowest-precedence source. */
export async function personalCatalog(native: LocalSkillPort): Promise<PartialCatalog> {
  const catalog: PartialCatalog = { skills: [], diagnostics: [] };
  const report = (location: string, detail: string, severity: 'skipped' | 'warning') =>
    catalog.diagnostics.push({ source: 'personal', location, message: detail, severity });
  try {
    for (const document of (await native.listRuntimeDocuments(PERSONAL_PREFIX)).sort()) {
      const name = document.slice(PERSONAL_PREFIX.length, -'.json'.length);
      const location = `personal/${name}`;
      try {
        const raw = validSkillName(name) ? await native.readRuntimeDocument(document) : null;
        if (raw !== null) {
          const warn = (detail: string) => report(location, detail, 'warning');
          const definition = parsePersonalSkill(raw, name).files['SKILL.md'] ?? '';
          catalog.skills.push({
            ...parseSkillDefinition(definition, name, warn),
            source: 'personal',
            sourceKind: 'personal',
            sourceRoot: 'personal',
            layout: 'directory',
            location,
          });
        }
      } catch (error) {
        report(location, message(error), 'skipped');
      }
    }
  } catch (error) {
    report('personal', message(error), 'skipped');
  }
  return catalog;
}

async function readBundle(
  native: LocalSkillPort,
  workspace: string,
  root: string,
  used: number,
): Promise<{ files: Record<string, string>; skipped: LocalSkippedSkillFile[] }> {
  const walk = await walkBundle(native, workspace, root, PERSONAL_SKILL_FILES);
  const files = new Map<string, string>();
  const skipped = [...walk.skipped];
  if (walk.truncated) {
    skipped.push({ path: '.', reason: `Only ${String(PERSONAL_SKILL_FILES)} files are imported.` });
  }
  for (const file of walk.files) {
    if (used + file.bytes > PERSONAL_SKILL_BYTES) {
      skipped.push({ path: file.path, reason: 'Exceeds the 4 MiB personal skill limit.' });
      continue;
    }
    try {
      const path = `${root}/${file.path}`;
      const content = await readWhole(native, workspace, path, PERSONAL_SKILL_BYTES - used);
      files.set(file.path, content);
      used += utf8Bytes(content);
    } catch (error) {
      const binary = isOnDeviceNativeError(error, 'FILE_NOT_TEXT');
      skipped.push({ path: file.path, reason: binary ? 'Binary file.' : message(error) });
    }
  }
  return { files: Object.fromEntries(files), skipped };
}

/** Copies SKILL.md and bundled UTF-8 files from a workspace skill directory; replaces by ID. */
export async function importPersonalSkill(
  native: LocalSkillPort,
  workspace: string,
  root: string,
): Promise<LocalSkillImport> {
  const name = root.split('/').at(-1) ?? '';
  if (!validSkillName(name)) {
    throw new Error(
      'Personal skill folders must be 1-64 lowercase letters/digits with single hyphens.',
    );
  }
  const definition = await readWhole(
    native,
    workspace,
    `${root}/SKILL.md`,
    PERSONAL_SKILL_BYTES,
  ).catch((error: unknown) => {
    throw isOnDeviceNativeError(error, 'PATH_NOT_FOUND')
      ? new Error(`${root} has no SKILL.md.`)
      : error;
  });
  parseSkillDefinition(definition, name);
  const names = await native.listRuntimeDocuments(PERSONAL_PREFIX);
  if (!names.includes(personalDocument(name)) && names.length >= PERSONAL_SKILL_LIMIT) {
    throw new Error(`At most ${String(PERSONAL_SKILL_LIMIT)} personal skills can be saved.`);
  }
  const bundle = await readBundle(native, workspace, root, utf8Bytes(definition));
  const files = { 'SKILL.md': definition, ...bundle.files };
  const raw = JSON.stringify({ version: 1, name, files, skipped: bundle.skipped });
  if (utf8Bytes(raw) > DOCUMENT_BYTES) {
    throw new Error('This skill is too large to save as a personal skill.');
  }
  await native.writeRuntimeDocument(personalDocument(name), raw);
  return { name, files: Object.keys(files), skipped: bundle.skipped };
}
