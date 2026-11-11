import { randomUUID } from 'expo-crypto';
import { AGENT_COMMANDS_EVENT_NAME } from '@bridge/agentCommands';
import { loadNativeModelContext } from '../models/engine';
import { OnDeviceNativeError } from '../native/services.errors';
import { createRuntimeAgentPort } from '../transport/runtimePort';
import { LocalBridgeServer, type LocalNotification } from '../transport/server';
import { OnDeviceRuntime } from './runtime';
import { SKILL_PAGE_BYTES } from './skills';
import { createFakeOnDeviceNative, FakeLlama, type ScriptedReply } from './testing';
import type { LocalMessage, LocalThread } from './types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const modelId = 'qwen3-1.7b-q4-k-m';
const skill = (name: string, fields = '', body = `${name.toUpperCase()} BODY`) =>
  `---\nname: ${name}\ndescription: ${name} description.\n${fields}---\n${body}`;
const call = (name: string, args: Record<string, unknown> = {}): ScriptedReply => ({
  toolCalls: [{ name, arguments: args }],
});

beforeEach(() => {
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for the runtime.');
}

async function harness(files: Record<string, string> = {}, documents?: Record<string, string>) {
  const llama = new FakeLlama();
  jest.mocked(loadNativeModelContext).mockImplementation(llama.loader);
  const fake = createFakeOnDeviceNative(llama, {
    downloaded: [modelId],
    files,
    ...(documents ? { documents } : {}),
    workspaces: [
      { id: 'ws-one', name: 'One', isRepository: true },
      { id: 'ws-two', name: 'Two', isRepository: true },
    ],
  });
  const runtime = new OnDeviceRuntime(fake.native, { emitIntervalMs: 0, threadProgressDelayMs: 0 });
  await runtime.initialize();
  const thread = await runtime.threads.create('ws-one', modelId);
  const generate = jest.spyOn(runtime.models, 'generate');
  const prompt = (round: number) => generate.mock.calls[round]?.[0][0]?.content ?? '';
  const history = (round: number) => JSON.stringify(generate.mock.calls[round]?.[0].slice(1));
  const tools = (value: LocalThread = runtime.threads.get(thread.id)) =>
    value.messages.filter((message): message is LocalMessage & { tool: object } =>
      Boolean(message.tool),
    );
  const output = (message: LocalMessage | undefined): Record<string, unknown> =>
    JSON.parse(message?.content ?? '{}') as Record<string, unknown>;
  return { ...fake, llama, runtime, thread, generate, prompt, history, tools, output };
}

test('project roots follow .opencode > .github > .agents > .claude and win over personal skills', async () => {
  const h = await harness({
    'ws-one:.github/skills/review/SKILL.md': skill('review', '', 'GITHUB REVIEW'),
    'ws-one:.claude/skills/review/SKILL.md': skill('review', '', 'CLAUDE REVIEW'),
    'ws-one:.claude/skills/plan/SKILL.md': skill('plan'),
    'ws-one:.agents/skills/plan/SKILL.md': skill('plan', '', 'AGENTS PLAN'),
    'ws-one:.opencode/skills/lint/SKILL.md': skill('lint'),
    'ws-one:.agents/skills/lint/SKILL.md': skill('lint', '', 'AGENTS LINT'),
    'ws-one:library/skills/review/SKILL.md': skill('review', '', 'PERSONAL REVIEW'),
    'ws-one:library/skills/notes/SKILL.md': skill('notes'),
  });
  await h.runtime.skills.importPersonal('ws-one', 'library/skills/review');
  await h.runtime.skills.importPersonal('ws-one', 'library/skills/notes');
  const listing = await h.runtime.skills.list('ws-one');
  expect(listing.skills.map((entry) => [entry.name, entry.source, entry.location])).toEqual([
    ['lint', 'project', '.opencode/skills/lint'],
    ['review', 'project', '.github/skills/review'],
    ['plan', 'project', '.agents/skills/plan'],
    ['notes', 'personal', 'personal/notes'],
  ]);
  expect(listing.diagnostics.map((entry) => [entry.location, entry.message])).toEqual([
    ['.agents/skills/lint', 'Shadowed by the project skill .opencode/skills/lint.'],
    ['.claude/skills/plan', 'Shadowed by the project skill .agents/skills/plan.'],
    ['.claude/skills/review', 'Shadowed by the project skill .github/skills/review.'],
    ['personal/review', 'Shadowed by the project skill .github/skills/review.'],
  ]);
  const elsewhere = await h.runtime.skills.list('ws-two');
  expect(elsewhere.skills.map((entry) => [entry.name, entry.source])).toEqual([
    ['notes', 'personal'],
    ['review', 'personal'],
  ]);
  h.llama.reply(call('skill', { name: 'review' }), { content: 'Done.' });
  const result = await h.runtime.loop.send(h.thread.id, 'Review.', 'precedence');
  expect(h.tools(result)[0]?.content).toContain('GITHUB REVIEW');
  await h.runtime.dispose();
});

test('catalogs are cached by the workspace change token and the personal-store version', async () => {
  const h = await harness({
    'ws-one:.github/skills/review/SKILL.md': skill('review'),
    'ws-one:library/notes/SKILL.md': skill('notes'),
  });
  const read = jest.spyOn(h.native, 'readWorkspaceFile');
  const prefixReads = () =>
    read.mock.calls.filter(([, path]) => path === '.github/skills/review/SKILL.md').length;
  const configReads = () => read.mock.calls.filter(([, path]) => path === 'opencode.json').length;
  h.llama.reply(call('git_status'), call('git_status'), { content: 'Done.' });
  await h.runtime.loop.send(h.thread.id, 'Check status.', 'cached');
  expect(h.generate).toHaveBeenCalledTimes(3);
  expect(prefixReads()).toBe(1);
  expect(configReads()).toBe(1);
  h.files.set('ws-one:.github/skills/review/SKILL.md', skill('review', 'argument-hint: "[pr]"\n'));
  await h.runtime.loop.send(h.thread.id, 'Hello', 'changed-token');
  expect(prefixReads()).toBe(2);
  expect(configReads()).toBe(2);
  expect((await h.runtime.skills.list('ws-one')).diagnostics).toEqual([]);
  expect((await h.runtime.skills.list('ws-one')).skills[0]?.argumentHint).toBe('[pr]');
  expect(h.prompt(3)).not.toContain('- notes:');
  await h.runtime.skills.importPersonal('ws-one', 'library/notes');
  await h.runtime.loop.send(h.thread.id, 'Hello again', 'personal-version');
  expect(h.prompt(4)).toContain('- notes: notes description.');
  await h.runtime.skills.removePersonal('notes');
  await h.runtime.loop.send(h.thread.id, 'Once more', 'personal-removed');
  expect(h.prompt(5)).not.toContain('- notes:');
  expect(prefixReads()).toBe(2);
  await h.runtime.dispose();
});

test('a large SKILL.md is paged with nextOffset and never offloaded to an artifact', async () => {
  const body = Array.from({ length: 800 }, (_, line) => `Step ${String(line)}: do it.`).join('\n');
  const definition = skill('big', '', body);
  const h = await harness({ 'ws-one:.github/skills/big/SKILL.md': definition });
  h.llama.reply(
    call('skill', { name: 'big' }),
    call('skill', { name: 'big', offset: SKILL_PAGE_BYTES }),
    { content: 'Read it all.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, 'Use big.', 'paged');
  const [first, second] = h.tools(result).map(h.output);
  expect(first).toMatchObject({ offset: 0, nextOffset: SKILL_PAGE_BYTES });
  expect(first?.['offloaded']).toBeUndefined();
  expect(first?.['content']).toBe(definition.slice(0, SKILL_PAGE_BYTES));
  expect(second).toMatchObject({ offset: SKILL_PAGE_BYTES });
  expect(String(first?.['content']) + String(second?.['content'])).toBe(
    definition.slice(0, SKILL_PAGE_BYTES * 2),
  );
  expect(h.history(1)).toContain('Step 1: do it.');
  expect([...h.documents.keys()].some((name) => name.startsWith('toolartifact-'))).toBe(false);
  await h.runtime.dispose();
});

test('every bundled file is listed and readable by path for project and personal skills; binaries fail explicitly', async () => {
  const root = '.github/skills/release';
  const h = await harness({
    [`ws-one:${root}/SKILL.md`]: skill('release'),
    [`ws-one:${root}/references/guide.md`]: 'GUIDE TEXT',
    [`ws-one:${root}/scripts/deploy.sh`]: 'echo deploy',
    [`ws-one:${root}/assets/logo.png`]: 'binary',
  });
  const read = h.native.readWorkspaceFile;
  jest
    .spyOn(h.native, 'readWorkspaceFile')
    .mockImplementation((id, path, offset, limit) =>
      path.endsWith('logo.png')
        ? Promise.reject(new OnDeviceNativeError('FILE_NOT_TEXT', 'Not text.'))
        : read(id, path, offset, limit),
    );
  h.llama.reply(
    call('skill', { name: 'release' }),
    call('skill', { name: 'release', resource: 'scripts/deploy.sh' }),
    call('skill', { name: 'release', resource: 'assets/logo.png' }),
    { content: 'Done.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, 'Release.', 'project-files');
  const [loaded, script, binary] = h.tools(result);
  expect(h.output(loaded)).toMatchObject({
    files: ['assets/logo.png', 'references/guide.md', 'scripts/deploy.sh'],
    note: expect.stringContaining('scripts cannot run on this device'),
  });
  expect(h.output(script)).toMatchObject({ resource: 'scripts/deploy.sh', content: 'echo deploy' });
  expect(binary).toMatchObject({
    tool: { status: 'failed' },
    content: expect.stringContaining('binary; only UTF-8 text'),
  });

  const imported = await h.runtime.skills.importPersonal('ws-one', root);
  expect(imported).toEqual({
    name: 'release',
    files: ['SKILL.md', 'references/guide.md', 'scripts/deploy.sh'],
    skipped: [{ path: 'assets/logo.png', reason: 'Binary file.' }],
  });
  const personal = await h.runtime.threads.create('ws-two', modelId);
  h.llama.reply(
    call('skill', { name: 'release' }),
    call('skill', { name: 'release', resource: 'references/guide.md' }),
    call('skill', { name: 'release', resource: 'assets/logo.png' }),
    { content: 'Done.' },
  );
  const second = await h.runtime.loop.send(personal.id, 'Release.', 'personal-files');
  const [personalLoad, guide, skipped] = h.tools(second);
  expect(h.output(personalLoad)).toMatchObject({
    source: 'personal',
    location: 'personal/release',
    files: ['references/guide.md', 'scripts/deploy.sh'],
    skippedFiles: [{ path: 'assets/logo.png', reason: 'Binary file.' }],
  });
  expect(h.output(guide)).toMatchObject({ content: 'GUIDE TEXT', nextOffset: null });
  expect(skipped?.content).toContain('assets/logo.png was not imported: Binary file.');
  const workspaceTwoReads = h.calls.filter((entry) =>
    entry.startsWith('readWorkspaceFile:["ws-two"'),
  );
  expect(workspaceTwoReads.some((entry) => entry.includes('release'))).toBe(false);
  await h.runtime.dispose();
});

test('disable-model-invocation hides a skill from the model until the user runs it with a slash command', async () => {
  const h = await harness({
    'ws-one:.github/skills/deploy/SKILL.md': skill(
      'deploy',
      'disable-model-invocation: true\nargument-hint: "[env]"\n',
      'DEPLOY STEPS',
    ),
    'ws-one:.github/skills/deploy/notes.md': 'DEPLOY NOTES',
  });
  h.llama.reply(call('skill', { name: 'deploy' }), call('skill'), { content: 'Cannot.' });
  const refused = await h.runtime.loop.send(h.thread.id, 'Deploy please.', 'model-refused');
  expect(h.prompt(0)).not.toContain('deploy');
  expect(h.tools(refused)[0]).toMatchObject({
    tool: { status: 'failed' },
    content: expect.stringContaining('Only the user can run this skill, by typing /deploy.'),
  });
  expect(h.output(h.tools(refused)[1])).toEqual({ skills: [], total: 0, nextOffset: null });
  expect(h.runtime.skills.commands('ws-one')).toEqual([
    { name: 'deploy', description: 'deploy description.', hint: '[env]' },
  ]);

  h.llama.reply(call('skill', { name: 'deploy', resource: 'notes.md' }), {
    fail: 'Model crashed.',
  });
  await expect(h.runtime.loop.send(h.thread.id, '/deploy staging', 'slash-deploy')).rejects.toThrow(
    'Model crashed.',
  );
  let thread = h.runtime.threads.get(h.thread.id);
  const turn = thread.messages.slice(
    thread.messages.findIndex((entry) => entry.id === 'user-slash-deploy'),
  );
  expect(turn[0]).toMatchObject({ role: 'user', content: '/deploy staging' });
  expect(turn[1]?.toolCalls?.[0]).toMatchObject({
    id: expect.stringMatching(/^slash-/u),
    function: { name: 'skill', arguments: '{"name":"deploy","prompt":"staging"}' },
  });
  expect(turn[2]).toMatchObject({ tool: { status: 'completed' } });
  expect(turn[2]?.content).toContain('DEPLOY STEPS');
  expect(turn[4]).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('DEPLOY NOTES'),
  });
  expect(h.history(3)).toContain('DEPLOY STEPS');

  const reads = jest.spyOn(h.native, 'readWorkspaceFile');
  h.llama.reply(call('skill', { name: 'deploy', resource: 'notes.md' }), { content: 'Deployed.' });
  thread = await h.runtime.loop.retry(h.thread.id);
  expect(thread.status).toBe('complete');
  const slashCalls = thread.messages.filter((entry) =>
    entry.toolCalls?.some((item) => item.id.startsWith('slash-')),
  );
  expect(slashCalls).toHaveLength(1);
  expect(reads.mock.calls.filter(([, path]) => path.endsWith('deploy/SKILL.md'))).toHaveLength(0);
  expect(h.tools(thread).at(-1)).toMatchObject({ tool: { status: 'completed' } });
  await h.runtime.dispose();
});

test('user-invocable false is not a slash command, but the model can still load it; unknown commands stay text', async () => {
  const h = await harness({
    'ws-one:.github/skills/helper/SKILL.md': skill('helper', 'user-invocable: false\n'),
  });
  expect(h.runtime.skills.commands('ws-one')).toEqual([]);
  await h.runtime.skills.list('ws-one');
  expect(h.runtime.skills.commands('ws-one')).toEqual([]);
  h.llama.reply({ content: 'Plain.' });
  const plain = await h.runtime.loop.send(h.thread.id, '/helper now', 'not-command');
  h.llama.reply({ content: 'Plain too.' });
  const unknown = await h.runtime.loop.send(h.thread.id, '/nope', 'unknown-command');
  expect(h.tools(plain)).toHaveLength(0);
  expect(h.tools(unknown)).toHaveLength(0);
  expect(
    unknown.messages.filter((entry) => entry.role === 'user').map((entry) => entry.content),
  ).toEqual(['/helper now', '/nope']);
  expect(h.prompt(0)).toContain('- helper: helper description.');
  h.llama.reply(call('skill', { name: 'helper' }), { content: 'Helped.' });
  const loaded = await h.runtime.loop.send(h.thread.id, 'Help.', 'model-helper');
  expect(h.tools(loaded).at(-1)).toMatchObject({ tool: { status: 'completed' } });
  await h.runtime.dispose();
});

test('a context: fork skill runs in a fresh child and returns only the child result', async () => {
  const h = await harness({
    'ws-one:.github/skills/audit/SKILL.md': skill('audit', 'context: fork\n', 'AUDIT INSTRUCTIONS'),
  });
  h.llama.reply(
    call('read_file', { path: '.github/skills/audit/SKILL.md' }),
    { content: 'Child audit finding.' },
    { content: 'Parent summary.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, '/audit the parser', 'fork-slash');
  expect(result.status).toBe('complete');
  const forked = h.tools(result)[0];
  expect(h.output(forked)).toMatchObject({
    name: 'audit',
    context: 'fork',
    agent: 'general',
    status: 'complete',
    summary: 'Child audit finding.',
  });
  expect(forked?.children?.[0]?.messages[0]?.content).toMatch(
    /^Run the audit skill for this request: the parser\. Follow its SKILL\.md[\s\S]*AUDIT INSTRUCTIONS/u,
  );
  expect(h.prompt(0)).toContain('You are a general child.');
  expect(h.history(2)).toContain('Child audit finding.');
  expect(h.history(2)).not.toContain('read_file');
  await h.runtime.dispose();
});

test('Stop during a forked skill cancels the child and settles the turn', async () => {
  const h = await harness({
    'ws-one:.github/skills/audit/SKILL.md': skill('audit', 'context: fork\n'),
  });
  h.llama.holdCompletions = true;
  h.llama.reply(call('skill', { name: 'audit', prompt: 'inspect' }));
  const running = h.runtime.loop.send(h.thread.id, 'Audit it.', 'fork-stop');
  await until(() => h.llama.completionPending);
  h.llama.finishCompletion();
  await until(
    () => h.llama.completionPending && (h.tools()[0]?.children?.[0]?.messages.length ?? 0) > 0,
  );
  await h.runtime.loop.stop();
  const settled = await running;
  expect(settled.status).toBe('interrupted');
  expect(h.tools(settled)[0]?.tool.status).toBe('interrupted');
  expect(h.tools(settled)[0]?.children?.[0]?.status).toBe('interrupted');
  expect(h.runtime.loop.snapshot().phase).toBe('idle');
  await h.runtime.dispose();
});

test('allowed-tools pre-approves mapped tools for the rest of one run only and reports ignored entries', async () => {
  const h = await harness({
    'ws-one:.github/skills/ship/SKILL.md': skill(
      'ship',
      'allowed-tools: git_push shell Bash(git:*) web_fetch(domain:x) teleport\n',
    ),
  });
  h.llama.reply(call('skill', { name: 'ship' }), call('git_push'), { content: 'Shipped.' });
  const first = await h.runtime.loop.send(h.thread.id, 'Ship it.', 'pre-approved');
  const [loaded, pushed] = h.tools(first);
  expect(h.output(loaded)).toMatchObject({
    preApprovedTools: ['git_push'],
    ignoredAllowedTools: [
      { tool: 'shell', reason: 'There is no shell on this device.' },
      { tool: 'Bash(git:*)', reason: 'There is no shell on this device.' },
      { tool: 'web_fetch(domain:x)', reason: 'Argument-scoped approvals are not supported.' },
      { tool: 'teleport', reason: 'This agent has no such tool.' },
    ],
  });
  expect(pushed).toMatchObject({ tool: { status: 'completed' } });
  expect(h.calls).toContain('pushWorkspaceGit:["ws-one"]');

  h.llama.reply(call('git_push'), { content: 'Not pushed.' });
  const second = h.runtime.loop.send(h.thread.id, 'Push again.', 'needs-approval');
  await until(() => h.runtime.loop.snapshot().approval !== null);
  const approval = h.runtime.loop.snapshot().approval;
  expect(approval).toMatchObject({ toolName: 'git_push' });
  h.runtime.loop.resolveApproval(approval?.callId ?? '', false);
  const settled = await second;
  expect(h.tools(settled).at(-1)?.content).toContain('The user declined this request');
  expect(h.calls.filter((entry) => entry === 'pushWorkspaceGit:["ws-one"]')).toHaveLength(1);
  await h.runtime.dispose();
});

test('an explore child that loads a skill gets only the allowed tools its role already has', async () => {
  const h = await harness({
    'ws-one:.github/skills/ship/SKILL.md': skill('ship', 'allowed-tools: git_push web_search\n'),
  });
  h.llama.reply(
    call('task', { tasks: [{ agent: 'explore', prompt: 'Use the ship skill.' }] }),
    call('skill', { name: 'ship' }),
    call('git_push'),
    { content: 'Could not push.' },
    { content: 'Parent done.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, 'Delegate.', 'explore-skill');
  const child = h.tools(result)[0]?.children?.[0];
  const childTools = (child?.messages ?? []).filter((entry) => entry.tool);
  expect(h.output(childTools[0])).toMatchObject({
    preApprovedTools: ['web_search'],
    ignoredAllowedTools: [{ tool: 'git_push', reason: 'This agent has no such tool.' }],
  });
  expect(childTools[1]).toMatchObject({
    tool: { status: 'failed' },
    content: expect.stringContaining('read-only'),
  });
  expect(h.calls).not.toContain('pushWorkspaceGit:["ws-one"]');
  await h.runtime.dispose();
});

test('a missing, blank, or listing-word name lists skills, while a skill with that ID still loads', async () => {
  const h = await harness({ 'ws-one:.github/skills/review/SKILL.md': skill('review') });
  h.llama.reply(
    call('skill', { name: 'list' }),
    call('skill', { name: 'All' }),
    call('skill', { name: '*' }),
    call('skill', { name: ' ' }),
    call('skill', { name: null }),
    call('skill', {}),
    call('skill', { name: 'nope' }),
    { content: 'Done.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, 'Which skills exist?', 'listing');
  const listing = {
    skills: [{ name: 'review', description: 'review description.' }],
    total: 1,
    nextOffset: null,
  };
  const tools = h.tools(result);
  expect(tools.slice(0, 6).map((message) => [message.tool.status, h.output(message)])).toEqual(
    Array.from({ length: 6 }, () => ['completed', listing]),
  );
  expect(tools[6]).toMatchObject({
    tool: { status: 'failed' },
    content: expect.stringContaining('No enabled skill is named \\"nope\\"'),
  });
  await h.runtime.dispose();

  const named = await harness({ 'ws-one:.github/skills/list/SKILL.md': skill('list') });
  named.llama.reply(call('skill', { name: 'list' }), { content: 'Done.' });
  const loaded = await named.runtime.loop.send(named.thread.id, 'Load it.', 'named-list');
  expect(named.tools(loaded)[0]).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('LIST BODY'),
  });
  await named.runtime.dispose();
});

test('import, remove, and enable/disable persist across a runtime reload', async () => {
  const h = await harness({
    'ws-one:.github/skills/review/SKILL.md': skill('review'),
    'ws-one:shared/notes/SKILL.md': skill('notes', 'argument-hint: "[topic]"\n'),
    'ws-one:shared/drop/SKILL.md': skill('drop'),
  });
  const changes = jest.fn();
  h.runtime.subscribe(changes, ['skills']);
  await h.runtime.skills.importPersonal('ws-one', 'shared/notes');
  await h.runtime.skills.importPersonal('ws-one', 'shared/drop');
  await h.runtime.skills.removePersonal('drop');
  await h.runtime.skills.setEnabled('review', false);
  expect(changes).toHaveBeenCalled();
  expect(h.runtime.preferences().disabledSkills).toEqual(['review']);
  await h.runtime.flush();
  const documents = Object.fromEntries(h.documents);
  await h.runtime.dispose();

  const reloaded = await harness(
    { 'ws-one:.github/skills/review/SKILL.md': skill('review') },
    documents,
  );
  const listing = await reloaded.runtime.skills.list('ws-one');
  expect(listing.skills.map((entry) => [entry.name, entry.source, entry.enabled])).toEqual([
    ['review', 'project', false],
    ['notes', 'personal', true],
  ]);
  expect(reloaded.runtime.skills.commands('ws-one')).toEqual([
    { name: 'notes', description: 'notes description.', hint: '[topic]' },
  ]);
  reloaded.llama.reply(call('skill', { name: 'review' }), { content: 'Disabled.' });
  const result = await reloaded.runtime.loop.send(reloaded.thread.id, '/review', 'disabled');
  expect(reloaded.prompt(0)).not.toContain('- review:');
  expect(reloaded.tools(result)[0]).toMatchObject({
    tool: { status: 'failed' },
    content: expect.stringContaining('No enabled skill is named \\"review\\"'),
  });
  await reloaded.runtime.skills.setEnabled('review', true);
  expect((await reloaded.runtime.skills.list('ws-one')).skills[0]?.enabled).toBe(true);
  await reloaded.runtime.dispose();
});

test('the local transport publishes skill commands in snapshots and as live AG-UI events', async () => {
  const h = await harness({
    'ws-one:.github/skills/review/SKILL.md': skill(
      'review',
      `argument-hint: "${'é'.repeat(200)}"\n`,
    ),
    'ws-one:.github/skills/quiet/SKILL.md': skill('quiet', 'user-invocable: false\n'),
  });
  const server = new LocalBridgeServer(createRuntimeAgentPort(h.runtime));
  const notifications: LocalNotification[] = [];
  server.onNotification((notification) => notifications.push(notification));
  server.start();
  await h.runtime.skills.list('ws-one');
  const commandEvents = () =>
    notifications.filter(
      (entry) =>
        entry.method === 'bridge/agui.event' &&
        (entry.params['event'] as { name?: string }).name === AGENT_COMMANDS_EVENT_NAME,
    );
  const read = (await server.request('thread/read', { threadId: h.thread.id })) as {
    thread: { acpSnapshot: { commands: unknown[] } };
  };
  const review = { name: 'review', description: 'review description.', hint: 'é'.repeat(128) };
  expect(read.thread.acpSnapshot.commands).toEqual([review]);
  await until(() => commandEvents().length === 1);
  expect(commandEvents()[0]?.params).toMatchObject({
    threadId: h.thread.id,
    runId: `${h.thread.id}::turn::commands-${h.thread.id}`,
    event: { type: 'CUSTOM', name: AGENT_COMMANDS_EVENT_NAME, value: { commands: [review] } },
  });

  h.files.set('ws-one:.github/skills/ship/SKILL.md', skill('ship'));
  h.runtime.skills.commands('ws-one', true);
  await until(() => commandEvents().length === 2);
  expect(commandEvents()[1]?.params['event']).toMatchObject({
    value: { commands: [review, { name: 'ship', description: 'ship description.' }] },
  });
  await h.runtime.skills.setEnabled('review', false);
  await until(() => commandEvents().length === 3);
  expect(commandEvents()[2]?.params['event']).toMatchObject({
    value: { commands: [{ name: 'ship', description: 'ship description.' }] },
  });
  server.stop();
  await h.runtime.dispose();
});
