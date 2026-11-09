import { isRecord } from '@shared/records';
import { isOnDeviceNativeError } from '../native/services.errors';
import type { OnDeviceNativeServices } from '../native/services.types';
import { safeWorkspacePath } from './workspaceGuidance';

export type LocalSkillEffect = 'allow' | 'ask' | 'deny';
/** OpenCode's built-in agent IDs: `build` is the conversation, `general`/`explore` its children. */
export type LocalSkillAgent = 'build' | 'general' | 'explore';
export const LOCAL_SKILL_AGENTS: readonly LocalSkillAgent[] = ['build', 'general', 'explore'];

/** An OpenCode `skill` permission rule: `*`/`?` wildcards over the exact skill ID. */
export interface LocalSkillRule {
  pattern: string;
  effect: LocalSkillEffect;
}

/** A rule plus where it came from: `user`, or a config file and key. */
export interface LocalSkillSourcedRule extends LocalSkillRule {
  origin: string;
}

/** The effective effect for one skill and agent; `rule` is null for the default `allow`. */
export interface LocalSkillPermission {
  effect: LocalSkillEffect;
  rule: LocalSkillSourcedRule | null;
}

export type LocalSkillConfigSource =
  { kind: 'path'; root: string; file: string } | { kind: 'catalog'; url: string; file: string };

export interface LocalSkillConfigProblem {
  location: string;
  message: string;
}

/** What a workspace's `opencode.json(c)` files say about skills, merged in load order. */
export interface LocalSkillConfig {
  /** Explicit `skills` entries in registration order: a later entry wins an ID collision. */
  sources: LocalSkillConfigSource[];
  rules: LocalSkillSourcedRule[];
  agents: Record<LocalSkillAgent, { rules: LocalSkillSourcedRule[]; toolDisabled: boolean }>;
  problems: LocalSkillConfigProblem[];
}

/** Direct configs load first; `.opencode/` configs override them, as in OpenCode. */
export const SKILL_CONFIG_FILES = [
  'opencode.json',
  'opencode.jsonc',
  '.opencode/opencode.json',
  '.opencode/opencode.jsonc',
];
const CONFIG_BYTES = 65_536;
export const SKILL_RULE_LIMIT = 256;
const SOURCE_LIMIT = 32;
const EFFECTS: readonly unknown[] = ['allow', 'ask', 'deny'];

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The config could not be read.';
}

function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
    } else if (text[index] === '"') {
      return index + 1;
    }
  }
  return text.length;
}

/** The index just past a comment starting at `index`, or -1 when none starts there. */
function commentEnd(text: string, index: number): number {
  const kind = text[index] === '/' ? text[index + 1] : undefined;
  if (kind === '/') {
    const end = text.indexOf('\n', index);
    return end < 0 ? text.length : end;
  }
  if (kind !== '*') {
    return -1;
  }
  const end = text.indexOf('*/', index + 2);
  if (end < 0) {
    throw new SyntaxError('Unterminated block comment.');
  }
  return end + 2;
}

/** JSON with `//` and block comments and trailing commas, never touching string contents. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let comma = -1;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length;) {
    const skip = commentEnd(text, index);
    if (skip >= 0) {
      out += ' ';
      index = skip;
      continue;
    }
    const character = text[index] ?? '';
    if ((character === ']' || character === '}') && comma >= 0) {
      out = out.slice(0, comma) + out.slice(comma + 1);
    }
    const end = character === '"' ? stringEnd(text, index) : index + 1;
    out += text.slice(index, end);
    index = end;
    if (character === ',') {
      comma = out.length - 1;
    } else if (!/\s/u.test(character)) {
      comma = -1;
    }
  }
  return JSON.parse(out);
}

const compiled = new Map<string, RegExp>();

/** OpenCode's whole-value wildcards: `*` is any run of characters, `?` exactly one. */
export function skillPatternMatches(pattern: string, value: string): boolean {
  let expression = compiled.get(pattern);
  if (!expression) {
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/gu, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.');
    // ponytail: bounded by clearing; an LRU only matters with thousands of distinct patterns.
    if (compiled.size >= 1024) {
      compiled.clear();
    }
    expression = new RegExp(`^${source}$`, 'su');
    compiled.set(pattern, expression);
  }
  return expression.test(value);
}

/** The last matching rule wins; no match allows, like OpenCode's default policy. */
export function skillPermission(
  rules: readonly LocalSkillSourcedRule[],
  id: string,
): LocalSkillPermission {
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (rule && skillPatternMatches(rule.pattern, id)) {
      return { effect: rule.effect, rule };
    }
  }
  return { effect: 'allow', rule: null };
}

export function validSkillRule(rule: unknown): rule is LocalSkillRule {
  return (
    isRecord(rule) &&
    typeof rule['pattern'] === 'string' &&
    rule['pattern'].length > 0 &&
    rule['pattern'].length <= 128 &&
    EFFECTS.includes(rule['effect'])
  );
}

/** A plain HTTPS base URL ending in `/`; credentials, queries, and fragments are refused. */
export function catalogUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter an https:// skill catalog URL.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Skill catalogs must be https:// URLs without credentials, queries, or fragments.',
    );
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function emptyConfig(): LocalSkillConfig {
  const agent = () => ({ rules: [], toolDisabled: false });
  return {
    sources: [],
    rules: [],
    agents: { build: agent(), general: agent(), explore: agent() },
    problems: [],
  };
}

class ConfigReader {
  constructor(
    private readonly config: LocalSkillConfig,
    private readonly file: string,
  ) {}

  report(detail: string): void {
    this.config.problems.push({ location: this.file, message: detail });
  }

  add(rules: LocalSkillSourcedRule[], pattern: unknown, effect: unknown, key: string): void {
    const rule = { pattern, effect };
    if (!validSkillRule(rule)) {
      this.report(`${key}: rules need a 1-128 character pattern and allow, ask, or deny.`);
    } else if (rules.length >= SKILL_RULE_LIMIT) {
      this.report(`${key}: skipped; at most ${String(SKILL_RULE_LIMIT)} skill rules are read.`);
    } else {
      rules.push({ ...rule, origin: `${this.file} ${key}` });
    }
  }

  /** V1 `permission`: an effect for everything, or `{ skill: effect | { pattern: effect } }`. */
  v1(rules: LocalSkillSourcedRule[], permission: unknown, key: string): void {
    const skill = isRecord(permission) ? permission['skill'] : permission;
    if (typeof skill === 'string') {
      this.add(rules, '*', skill, `${key}${isRecord(permission) ? '.skill' : ''}`);
    } else if (isRecord(skill)) {
      for (const [pattern, effect] of Object.entries(skill)) {
        this.add(rules, pattern, effect, `${key}.skill`);
      }
    } else if (skill !== undefined) {
      this.report(`${key}.skill must be allow, ask, deny, or a map of patterns.`);
    }
  }

  /** V2 `permissions`: ordered `{ action, resource, effect }` rules; only `skill` actions apply. */
  v2(rules: LocalSkillSourcedRule[], permissions: unknown, key: string): void {
    if (permissions === undefined) {
      return;
    }
    if (!Array.isArray(permissions)) {
      this.report(`${key} must be an array of rules.`);
      return;
    }
    permissions.forEach((rule: unknown, index) => {
      const action = isRecord(rule) ? rule['action'] : undefined;
      if (typeof action !== 'string' || !isRecord(rule)) {
        this.report(`${key}[${String(index)}] needs action, resource, and effect.`);
      } else if (skillPatternMatches(action, 'skill')) {
        this.add(rules, rule['resource'], rule['effect'], `${key}[${String(index)}]`);
      }
    });
  }

  source(entry: unknown): void {
    if (typeof entry !== 'string' || !entry.trim()) {
      this.report('skills entries must be paths or URLs.');
    } else if (this.config.sources.length >= SOURCE_LIMIT) {
      this.report(`${entry}: skipped; at most ${String(SOURCE_LIMIT)} skill sources are read.`);
    } else if (/^https:\/\//iu.test(entry)) {
      try {
        this.config.sources.push({ kind: 'catalog', url: catalogUrl(entry), file: this.file });
      } catch (error) {
        this.report(`${entry}: ${message(error)}`);
      }
    } else if (/^[a-z][a-z0-9+.-]*:/iu.test(entry)) {
      this.report(`${entry}: only https:// skill catalogs are supported.`);
    } else if (entry.startsWith('~') || entry.startsWith('/')) {
      this.report(`${entry}: home and absolute paths are unavailable on iPhone.`);
    } else {
      const path = entry
        .trim()
        .replace(/^(?:\.\/)+/u, '')
        .replace(/\/+$/u, '');
      try {
        const root = safeWorkspacePath(path, true);
        this.config.sources.push({ kind: 'path', root, file: this.file });
      } catch (error) {
        this.report(`${entry}: ${message(error)}`);
      }
    }
  }

  apply(value: Record<string, unknown>): void {
    const skills = value['skills'];
    if (Array.isArray(skills)) {
      skills.forEach((entry: unknown) => this.source(entry));
    } else if (skills !== undefined) {
      this.report('skills must be an array of paths or URLs.');
    }
    this.v1(this.config.rules, value['permission'], 'permission');
    this.v2(this.config.rules, value['permissions'], 'permissions');
    for (const agent of LOCAL_SKILL_AGENTS) {
      const target = this.config.agents[agent];
      const v1 = isRecord(value['agent']) ? value['agent'][agent] : undefined;
      const v2 = isRecord(value['agents']) ? value['agents'][agent] : undefined;
      if (isRecord(v1)) {
        this.v1(target.rules, v1['permission'], `agent.${agent}.permission`);
        for (const [tool, on] of Object.entries(isRecord(v1['tools']) ? v1['tools'] : {})) {
          if (typeof on === 'boolean' && skillPatternMatches(tool, 'skill')) {
            target.toolDisabled = !on;
            this.report(
              `agent.${agent}.tools.${tool} is ${String(on)}: skills are ${on ? 'on' : 'off'} for ${agent}.`,
            );
          }
        }
      }
      if (isRecord(v2)) {
        this.v2(target.rules, v2['permissions'], `agents.${agent}.permissions`);
      }
    }
  }
}

/** Reads the workspace's OpenCode configs. A missing file is normal; a bad one is a problem. */
export async function loadSkillConfig(
  native: Pick<OnDeviceNativeServices, 'readWorkspaceFile'>,
  workspace: string,
): Promise<LocalSkillConfig> {
  const config = emptyConfig();
  const reads = await Promise.all(
    SKILL_CONFIG_FILES.map((file) =>
      native.readWorkspaceFile(workspace, file, 0, CONFIG_BYTES).then(
        (read) =>
          read.nextOffset === null
            ? read.content
            : new Error(`larger than ${String(CONFIG_BYTES)} bytes.`),
        (error: unknown) =>
          isOnDeviceNativeError(error, 'PATH_NOT_FOUND') ? null : new Error(message(error)),
      ),
    ),
  );
  reads.forEach((read, index) => {
    const reader = new ConfigReader(config, SKILL_CONFIG_FILES[index] ?? '');
    if (read === null) {
      return;
    }
    try {
      if (read instanceof Error) {
        throw read;
      }
      const value = parseJsonc(read);
      if (!isRecord(value)) {
        throw new Error('the config must be a JSON object.');
      }
      reader.apply(value);
    } catch (error) {
      reader.report(`Skipped: ${message(error)}`);
    }
  });
  return config;
}
