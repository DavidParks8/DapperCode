import { randomUUID } from 'expo-crypto';
import { isRecord } from '@shared/records';
import { interruptLocalRun } from './agentPolicy';
import type { LocalThreadPort } from './delegation';
import { validSkillName } from './skillCatalog';
import type {
  LocalSkill,
  LocalSkillAgent,
  LocalSkillCatalog,
  LocalSkillPage,
  LocalSkills,
} from './skills';
import { argumentsRecord, integer, LocalToolInputError, text } from './toolArguments';
import { toolDefinition, toolDefinitionName } from './toolDefinition';
import type { LocalAgentRun, LocalThread, LocalToolApprovalPolicy, LocalToolCall } from './types';

export const SKILL_TOOL_DEFINITIONS = [
  toolDefinition(
    'skill',
    'Load a listed Agent Skill by name and follow its instructions (nextOffset pages them). resource reads a bundled text file by skill-relative path; scripts cannot run. A fork skill runs as a child given prompt. Omit name to list skills.',
    {
      name: { type: 'string' },
      resource: { type: 'string' },
      offset: { type: 'integer' },
      prompt: { type: 'string' },
    },
    [],
    { kind: 'read', approval: null },
  ),
];

/** Skill state owned by one run: a retry or later turn starts without pre-approvals. */
export interface LocalSkillRun {
  /** Tools an activated skill's `allowed-tools` pre-approved for the rest of this run only. */
  preApproved: Set<string>;
  /** Skills the user named (`/id`, `@id`) or approved this turn: loadable even when hidden. */
  userSkills: Set<string>;
}

export interface LocalSkillToolContext {
  workspace: string;
  run: LocalSkillRun;
  /** OpenCode agent ID for per-agent rules: `build` (conversation), `general`, `explore`. */
  agent: LocalSkillAgent;
  /** The user approved this call because its skill's permission is `ask`. */
  approved: boolean;
  /** Tools registered for this agent; a child's are already narrowed to its role. */
  tools: readonly string[];
  /** The runtime's synthetic call for the user's `/id` or `@id`, never a model call. */
  userInvoked: boolean;
  /** Runs a fresh general child; null inside children, where fork skills load inline. */
  fork: ((prompt: string, seed: LocalSkillRun) => Promise<{ children: object[] }>) | null;
}

const SLASH_CALL = 'slash-';
const MENTION_CALL = 'mention-';
const MENTION = /(^|[\s([{"'`])@([A-Za-z0-9_][\w.-]*)/gu;
const MENTION_LIMIT = 3;
const PROMPT_LIMIT = 32_768;
const TRUNCATED = `\n[Request truncated to ${String(PROMPT_LIMIT)} characters.]`;
const LIST_PAGE = 32;
/** Small models name the listing instead of omitting `name`; a skill with that ID still wins. */
const LIST_NAMES = new Set(['list', 'all', '*']);
const LOADED_NOTE =
  'Follow these instructions for the current task. Read bundled files with skill name and resource only as needed; they are UTF-8 text and scripts cannot run on this device.';
const TOOL_ALIASES = new Map([
  ['fetch', 'web_fetch'],
  ['webfetch', 'web_fetch'],
  ['websearch', 'web_search'],
  ['read', 'read_file'],
  ['write', 'write_file'],
  ['edit', 'edit_file'],
  ['glob', 'glob_files'],
  ['grep', 'search_files'],
]);

/**
 * Maps `allowed-tools` to registered tools (exact names plus common aliases). Shell entries,
 * argument-scoped entries, and tools this agent lacks are reported, never granted.
 */
export function skillToolApprovals(entries: readonly string[], tools: readonly string[]) {
  const preApproved: string[] = [];
  const ignored: { tool: string; reason: string }[] = [];
  for (const entry of entries) {
    const base = entry.split('(')[0]?.toLowerCase() ?? '';
    const name = tools.includes(base) ? base : TOOL_ALIASES.get(base.replace(/[-_]/gu, ''));
    if (base === 'shell' || base === 'bash') {
      ignored.push({ tool: entry, reason: 'There is no shell on this device.' });
    } else if (base === 'skill') {
      ignored.push({ tool: entry, reason: 'Skill loading follows skill permissions.' });
    } else if (entry.includes('(')) {
      ignored.push({ tool: entry, reason: 'Argument-scoped approvals are not supported.' });
    } else if (!name || !tools.includes(name)) {
      ignored.push({ tool: entry, reason: 'This agent has no such tool.' });
    } else if (!preApproved.includes(name)) {
      preApproved.push(name);
    }
  }
  return { preApproved, ignored };
}

function listSkills(
  skills: LocalSkills,
  catalog: LocalSkillCatalog,
  context: LocalSkillToolContext,
  offset: number,
): object {
  const visible = catalog.skills.filter(
    (skill) =>
      skills.advertised(catalog, skill, context.agent) ||
      (context.run.userSkills.has(skill.name) &&
        skills.permission(catalog, skill.name, context.agent).effect !== 'deny'),
  );
  const page = visible.slice(offset, offset + LIST_PAGE).map((skill) => ({
    name: skill.name,
    ...(skill.displayName === skill.name ? {} : { displayName: skill.displayName }),
    description: skill.description.slice(0, 300),
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
  }));
  const next = offset + page.length;
  return { skills: page, total: visible.length, nextOffset: next < visible.length ? next : null };
}

/** A missing, null or blank name, or a listing word that is no skill's ID, lists skills. */
function listsSkills(catalog: LocalSkillCatalog, name: unknown): boolean {
  if (name === undefined || name === null || (typeof name === 'string' && !name.trim())) {
    return true;
  }
  return (
    typeof name === 'string' &&
    LIST_NAMES.has(name.trim().toLowerCase()) &&
    !catalog.skills.some((skill) => skill.name === name)
  );
}

/**
 * OpenCode rules: `deny` rejects everyone, and a hidden skill (no description, autoinvoke false,
 * or disable-model-invocation) loads only after the user named it.
 */
function invocableSkill(
  skills: LocalSkills,
  catalog: LocalSkillCatalog,
  name: string,
  context: LocalSkillToolContext,
): LocalSkill {
  const skill = catalog.skills.find((entry) => entry.name === name);
  if (!skill || skills.permission(catalog, name, context.agent).effect === 'deny') {
    throw new LocalToolInputError(
      `No enabled skill is named ${JSON.stringify(name)}. Call skill without a name to list skills.`,
    );
  }
  const named = context.userInvoked || context.run.userSkills.has(name);
  if (!named && !skills.advertised(catalog, skill, context.agent)) {
    const typed = `${validSkillName(name) ? '/' : '@'}${skill.name}`;
    throw new LocalToolInputError(`Only the user can run this skill, by typing ${typed}.`);
  }
  return skill;
}

/** A conversation's `context: fork` load runs in a `general` child, so it also needs general. */
function forksCall(skill: LocalSkill, input: Record<string, unknown>, forks: boolean): boolean {
  return forks && skill.context === 'fork' && input['resource'] === undefined && !input['offset'];
}

/** The general child may not use this skill (`deny` or `tools.skill: false`). */
function forkRefused(skills: LocalSkills, catalog: LocalSkillCatalog, name: string): boolean {
  return (
    !skills.toolEnabled(catalog, 'general') ||
    skills.permission(catalog, name, 'general').effect === 'deny'
  );
}

/** `ask` from the calling agent's rules or, for a fork, from the general child's rules. */
function needsApproval(
  skills: LocalSkills,
  catalog: LocalSkillCatalog,
  agent: LocalSkillAgent,
  skill: LocalSkill,
  input: Record<string, unknown>,
  forks: boolean,
): boolean {
  const fork = forksCall(skill, input, forks);
  if (fork && forkRefused(skills, catalog, skill.name)) {
    return false;
  }
  return (
    skills.permission(catalog, skill.name, agent).effect === 'ask' ||
    (fork && skills.permission(catalog, skill.name, 'general').effect === 'ask')
  );
}

/** One agent loop's skill wiring: tool visibility, `ask` approvals, activation, execution. */
export class LocalSkillBinding {
  /** Model `skill` calls that asked for approval because the skill's permission is `ask`. */
  private readonly asked = new Set<string>();

  constructor(
    private readonly skills: LocalSkills | undefined,
    readonly agent: LocalSkillAgent,
  ) {}

  /** Drops the skill tool when skills are off for this agent (global switch, `tools.skill`). */
  tools(definitions: object[], workspace: string): object[] {
    const catalog = this.skills?.cached(workspace);
    const skills = this.skills;
    const on =
      !skills || (catalog ? skills.toolEnabled(catalog, this.agent) : skills.skillsEnabled());
    return on ? definitions : definitions.filter((tool) => toolDefinitionName(tool) !== 'skill');
  }

  /**
   * The skill a model `skill` call must ask about (user-named or already-loaded skills are
   * consented), from the catalog the round's prompt just loaded; null when no `ask` applies.
   */
  private asks(run: LocalAgentRun, name: string, input: unknown): string | null {
    const catalog = this.skills?.cached(run.workspaceId);
    const id = isRecord(input) ? input['name'] : undefined;
    const skill = catalog?.skills.find((entry) => entry.name === id);
    return name === 'skill' &&
      this.skills &&
      catalog &&
      skill &&
      isRecord(input) &&
      !run.skills.userSkills.has(skill.name) &&
      needsApproval(this.skills, catalog, this.agent, skill, input, this.agent === 'build')
      ? skill.name
      : null;
  }

  /**
   * The skill-aware policy without side effects. Parallel read batching uses it, so the calls
   * it batches are exactly those that will not ask: `ask` loads run one at a time.
   */
  policy(policy: LocalToolApprovalPolicy, run: LocalAgentRun): LocalToolApprovalPolicy {
    return (name, input) => {
      const skill = this.asks(run, name, input);
      return skill ? { kind: 'other', summary: `Load the ${skill} skill` } : policy(name, input);
    };
  }

  /**
   * Adds OpenCode `ask` approval to a model `skill` call (kind `other`, so `on-request` still
   * asks) and remembers that it asked; the tool rechecks against a fresh catalog.
   */
  approval(
    policy: LocalToolApprovalPolicy,
    run: LocalAgentRun,
    callId: string,
  ): LocalToolApprovalPolicy {
    const decide = this.policy(policy, run);
    return (name, input) => {
      if (isUserSkillCall(callId)) {
        return policy(name, input);
      }
      const permission = decide(name, input);
      if (this.asks(run, name, input)) {
        this.asked.add(callId);
      }
      return permission;
    };
  }

  activate(
    threads: LocalThreadPort,
    run: LocalAgentRun,
    input: string,
    perform: (call: LocalToolCall) => Promise<void>,
  ): Promise<void> {
    return this.skills
      ? activateLocalUserSkills(threads, this.skills, run, input, perform)
      : Promise.resolve();
  }

  execute(
    run: LocalAgentRun,
    input: unknown,
    callId: string,
    tools: readonly string[],
    fork: LocalSkillToolContext['fork'],
  ): Promise<object> {
    if (!this.skills) {
      return Promise.reject(new LocalToolInputError('Skills are unavailable.'));
    }
    return executeLocalSkill(this.skills, input, {
      workspace: run.workspaceId,
      run: run.skills,
      agent: this.agent,
      approved: this.asked.delete(callId),
      tools,
      userInvoked: isUserSkillCall(callId),
      fork,
    });
  }
}

/**
 * Refuses a fork the general child may not run, requires approval for `ask` (from this agent or,
 * for a fork, from general) unless the user named the skill, then records consent for this run.
 * Returns the fork runner when this call forks.
 */
function admitSkill(
  skills: LocalSkills,
  catalog: LocalSkillCatalog,
  skill: LocalSkill,
  args: Record<string, unknown>,
  context: LocalSkillToolContext,
): LocalSkillToolContext['fork'] {
  const fork = forksCall(skill, args, context.fork !== null) ? context.fork : null;
  if (fork && forkRefused(skills, catalog, skill.name)) {
    throw new LocalToolInputError(
      'Not run: this context: fork skill runs in a general child, and the general agent may not use it (opencode.json denies it or turns its skills off).',
    );
  }
  const named = context.userInvoked || context.run.userSkills.has(skill.name);
  if (
    !named &&
    !context.approved &&
    needsApproval(skills, catalog, context.agent, skill, args, context.fork !== null)
  ) {
    throw new LocalToolInputError(
      'Not run: this skill now needs approval. Call skill again to ask the user.',
    );
  }
  context.run.userSkills.add(skill.name);
  return fork;
}

function forkPrompt(skill: LocalSkill, page: LocalSkillPage, request: string): string {
  const more =
    page.nextOffset === null
      ? ''
      : `\n\n[SKILL.md continues: call skill with name "${skill.name}" and offset ${String(page.nextOffset)}.]`;
  return `Run the ${skill.name} skill${request ? ` for this request: ${request}` : ''}. Follow its SKILL.md instructions:\n\n${page.content}${more}`;
}

/**
 * The `skill` tool. Results are bounded pages, never offloaded artifacts. Loading SKILL.md
 * activates the skill: its mapped `allowed-tools` skip approval for the rest of this run, or of
 * the fork child that runs it.
 */
export async function executeLocalSkill(
  skills: LocalSkills,
  input: unknown,
  context: LocalSkillToolContext,
): Promise<object> {
  const args = argumentsRecord(input, ['name', 'resource', 'offset', 'prompt']);
  const offset = integer(args, 'offset', 0, 0, 4 * 1024 * 1024);
  const catalog = await skills.catalog(context.workspace);
  if (!skills.toolEnabled(catalog, context.agent)) {
    throw new LocalToolInputError('Skills are turned off for this agent.');
  }
  if (listsSkills(catalog, args['name'])) {
    return listSkills(skills, catalog, context, offset);
  }
  const skill = invocableSkill(skills, catalog, text(args, 'name', 64), context);
  const fork = admitSkill(skills, catalog, skill, args, context);
  if (args['resource'] !== undefined) {
    const resource = text(args, 'resource', 1024);
    const page = await skills.read(context.workspace, skill, resource, offset);
    return { name: skill.name, resource, ...page };
  }
  const tools = fork
    ? context.tools.filter((tool) => tool !== 'task' && tool !== 'read_child')
    : context.tools;
  const { preApproved, ignored } = skillToolApprovals(skill.allowedTools, tools);
  const audit = { preApprovedTools: preApproved, ignoredAllowedTools: ignored };
  const page = await skills.read(context.workspace, skill, 'SKILL.md', offset);
  if (fork) {
    // Only a fork reads prompt; consent for the general child was settled above.
    const request = args['prompt'] === undefined ? '' : text(args, 'prompt', PROMPT_LIMIT);
    const { children } = await fork(forkPrompt(skill, page, request), {
      preApproved: new Set(preApproved),
      userSkills: new Set([skill.name]),
    });
    return { name: skill.name, context: 'fork', ...audit, ...children[0] };
  }
  for (const tool of preApproved) {
    context.run.preApproved.add(tool);
  }
  const files = offset === 0 ? await skills.files(context.workspace, skill) : {};
  return {
    name: skill.name,
    ...(skill.displayName === skill.name ? {} : { displayName: skill.displayName }),
    source: skill.source,
    location: skill.location,
    ...page,
    ...(offset === 0 ? { ...files, ...audit, note: LOADED_NOTE } : {}),
  };
}

export function parseSkillCommand(input: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/u.exec(input.trim());
  if (!match?.[1] || match[1].length > 64) {
    return null;
  }
  return { name: match[1], args: match[2]?.trim() ?? '' };
}

export function isUserSkillCall(callId: string): boolean {
  return callId.startsWith(SLASH_CALL) || callId.startsWith(MENTION_CALL);
}

/** `@id` tokens at a word boundary, in order; a trailing period ends the sentence, not the ID. */
export function skillMentions(input: string): string[] {
  return [...input.matchAll(MENTION)].map((match) => (match[2] ?? '').replace(/\.+$/u, ''));
}

/** The user's full message stays in the conversation; a skill call carries a bounded copy. */
function boundedPrompt(value: string): string {
  return value.length > PROMPT_LIMIT
    ? value.slice(0, PROMPT_LIMIT - TRUNCATED.length) + TRUNCATED
    : value;
}

function userCall(prefix: string, name: string, prompt: string): LocalToolCall {
  return {
    id: `${prefix}${randomUUID()}`,
    type: 'function',
    function: {
      name: 'skill',
      arguments: JSON.stringify({ name, ...(prompt ? { prompt } : {}) }),
    },
  };
}

/**
 * `/id args` at the start of a message and up to three `@id` mentions of permitted,
 * user-invocable skills activate them before the first model round as persisted `skill` calls;
 * the message itself stays verbatim. Unknown names stay plain text. Retry keeps the recorded
 * calls and never replays them.
 */
export async function activateLocalUserSkills(
  threads: LocalThreadPort,
  skills: LocalSkills,
  run: LocalAgentRun,
  input: string,
  perform: (call: LocalToolCall) => Promise<void>,
): Promise<void> {
  const command = parseSkillCommand(input);
  const mentions = skillMentions(input);
  if ((!command && !mentions.length) || !skills.skillsEnabled()) {
    return;
  }
  const catalog = await interruptLocalRun(run, skills.catalog(run.workspaceId));
  const named = (id: string) => {
    const skill = catalog.skills.find((entry) => entry.name === id);
    return skill && skills.userInvocable(catalog, skill) ? skill : null;
  };
  const calls: LocalToolCall[] = [];
  const slash = command ? named(command.name) : null;
  if (slash && command) {
    calls.push(userCall(SLASH_CALL, slash.name, boundedPrompt(command.args)));
  }
  const mentioned = [...new Set(mentions)].flatMap((id) => {
    const skill = id === slash?.name ? null : named(id);
    return skill ? [skill] : [];
  });
  for (const skill of mentioned.slice(0, MENTION_LIMIT)) {
    // A forked skill's child sees only its prompt, so it gets the whole message.
    const prompt = skill.context === 'fork' ? boundedPrompt(input) : '';
    calls.push(userCall(MENTION_CALL, skill.name, prompt));
  }
  if (run.stopped || !calls.length) {
    return;
  }
  const createdAt = new Date().toISOString();
  threads.change(run.threadId, (thread) => ({
    ...thread,
    messages: [
      ...thread.messages,
      { id: randomUUID(), role: 'assistant', content: '', createdAt, toolCalls: calls },
    ],
  }));
  for (const call of calls) {
    await perform(call);
  }
}

/** Skills the user activated in the latest turn, so retrying it keeps their user-only access. */
export function userActivatedSkills(thread: LocalThread): LocalSkillRun {
  const start = thread.messages.map((message) => message.role).lastIndexOf('user');
  const userSkills = new Set<string>();
  for (const message of thread.messages.slice(start + 1)) {
    for (const call of message.toolCalls ?? []) {
      const args: unknown = isUserSkillCall(call.id) ? JSON.parse(call.function.arguments) : null;
      if (isRecord(args) && typeof args['name'] === 'string') {
        userSkills.add(args['name']);
      }
    }
  }
  return { preApproved: new Set(), userSkills };
}
