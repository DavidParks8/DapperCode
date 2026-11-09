import { ReadableStream } from 'node:stream/web';
import { TextDecoder, TextEncoder } from 'node:util';
import { randomUUID } from 'expo-crypto';
import { fetch } from 'expo/fetch';
import { loadNativeModelContext } from '../models/engine';
import { OnDeviceRuntime } from './runtime';
import { LocalSkills } from './skills';
import { createFakeOnDeviceNative, FakeLlama, type ScriptedReply } from './testing';
import { toolDefinitionName } from './toolDefinition';
import type { LocalMessage, LocalThread } from './types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: TextDecoder });

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
  jest.mocked(fetch).mockReset();
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
    workspaces: [{ id: 'ws-one', name: 'One', isRepository: true }],
  });
  const runtime = new OnDeviceRuntime(fake.native, { emitIntervalMs: 0, threadProgressDelayMs: 0 });
  await runtime.initialize();
  const thread = await runtime.threads.create('ws-one', modelId);
  const generate = jest.spyOn(runtime.models, 'generate');
  const prompt = (round: number) => generate.mock.calls[round]?.[0][0]?.content ?? '';
  const advertised = (round: number) =>
    (generate.mock.calls[round]?.[1] ?? []).map(toolDefinitionName);
  const tools = (value: LocalThread = runtime.threads.get(thread.id)) =>
    value.messages.filter((message): message is LocalMessage & { tool: object } =>
      Boolean(message.tool),
    );
  const output = (message: LocalMessage | undefined): Record<string, unknown> =>
    JSON.parse(message?.content ?? '{}') as Record<string, unknown>;
  return { ...fake, llama, runtime, thread, generate, prompt, advertised, tools, output };
}

function respond(body: string, status = 200) {
  const encoder = new TextEncoder();
  return {
    status,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
  };
}

/** A fake HTTPS host: URL -> body, or an HTTP status. Unknown URLs are 404. */
function serve(routes: Map<string, string | number>) {
  jest.mocked(fetch).mockImplementation((async (url: string) => {
    const route = routes.get(url);
    return typeof route === 'string' ? respond(route) : respond('', route ?? 404);
  }) as unknown as typeof fetch);
  return () => jest.mocked(fetch).mock.calls.map(([url]) => url as string);
}

test('OpenCode layouts: root-level flat files and grouped SKILL.md leaves within six levels get path IDs', async () => {
  const root = 'ws-one:.opencode/skills';
  const h = await harness({
    [`${root}/review.md`]: 'REVIEW FLAT BODY',
    [`${root}/Mixed_Case.md`]: '---\ndescription: Mixed case flat.\n---\nMIXED BODY',
    [`${root}/teams/release/SKILL.md`]:
      '---\nname: Git Release\ndescription: Ship it.\n---\nRELEASE BODY',
    [`${root}/teams/release/guide.md`]: 'GUIDE',
    [`${root}/teams/release/inner/SKILL.md`]: skill('inner'),
    [`${root}/a/b/c/d/e/six/SKILL.md`]: skill('six'),
    [`${root}/a/b/c/d/e/f/seven/SKILL.md`]: skill('seven'),
    [`${root}/.hidden/SKILL.md`]: skill('hidden'),
    [`${root}/.secret.md`]: skill('secret'),
    [`${root}/node_modules/pkg/SKILL.md`]: skill('pkg'),
    [`${root}/docs/notes.md`]: skill('notes'),
    [`${root}/bad id/SKILL.md`]: skill('bad'),
  });
  const listing = await h.runtime.skills.list('ws-one');
  expect(
    listing.skills.map((entry) => [entry.id, entry.displayName, entry.layout, entry.location]),
  ).toEqual([
    ['Mixed_Case', 'Mixed_Case', 'flat', '.opencode/skills/Mixed_Case.md'],
    ['review', 'review', 'flat', '.opencode/skills/review.md'],
    ['release', 'Git Release', 'directory', '.opencode/skills/teams/release'],
    ['six', 'six', 'directory', '.opencode/skills/a/b/c/d/e/six'],
  ]);
  expect(listing.skills.map((entry) => [entry.id, entry.advertised, entry.sourceKind])).toEqual([
    ['Mixed_Case', true, 'project-root'],
    ['review', false, 'project-root'],
    ['release', true, 'project-root'],
    ['six', true, 'project-root'],
  ]);
  const diagnostics = listing.diagnostics.map((entry) => [
    entry.location,
    entry.severity,
    entry.message,
  ]);
  expect(diagnostics).toHaveLength(5);
  expect(diagnostics).toEqual(
    expect.arrayContaining([
      ['.opencode/skills/review.md', 'warning', expect.stringContaining('No description')],
      ['.opencode/skills/review.md', 'warning', expect.stringContaining('Portability')],
      ['.opencode/skills/Mixed_Case.md', 'warning', expect.stringContaining('Portability')],
      ['.opencode/skills/teams/release', 'warning', expect.stringContaining('Portability')],
      ['.opencode/skills/bad id', 'skipped', expect.stringContaining('IDs are 1-64 letters')],
    ]),
  );
  expect(
    h.calls.some((entry) => /hidden|secret|node_modules|seven|inner\/SKILL/u.test(entry)),
  ).toBe(false);
  expect(h.runtime.skills.commands('ws-one')).toEqual([
    { name: 'review', description: 'review' },
    { name: 'release', description: 'Ship it.' },
    { name: 'six', description: 'six description.' },
  ]);

  h.llama.reply(
    call('skill', { name: 'review' }),
    call('skill', { name: 'Mixed_Case' }),
    call('skill', { name: 'Mixed_Case', resource: 'other.md' }),
    call('skill', { name: 'release' }),
    { content: 'Done.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, 'Release it.', 'layouts');
  expect(h.prompt(0)).toContain('- release (Git Release): Ship it.');
  expect(h.prompt(0)).toContain('- Mixed_Case: Mixed case flat.');
  expect(h.prompt(0)).toContain('- six: six description.');
  expect(h.prompt(0)).not.toContain('- review');
  const [hidden, flat, flatResource, release] = h.tools(result);
  expect(hidden?.content).toContain('Only the user can run this skill, by typing /review.');
  expect(h.output(flat)).toMatchObject({
    content: expect.stringContaining('MIXED BODY'),
    files: [],
  });
  expect(flatResource?.content).toContain('a flat skill file has no bundled files');
  expect(h.output(release)).toMatchObject({
    name: 'release',
    displayName: 'Git Release',
    files: ['guide.md', 'inner/SKILL.md'],
  });
  await h.runtime.dispose();
});

test('@mentions activate permitted skills before the first round, persist, and are never replayed; autoinvoke decides advertising', async () => {
  const h = await harness({
    'ws-one:.github/skills/deploy/SKILL.md': skill(
      'deploy',
      'metadata:\n  opencode/autoinvoke: false\n',
    ),
    'ws-one:.github/skills/deploy/notes.md': 'DEPLOY NOTES',
    'ws-one:.github/skills/both/SKILL.md': skill(
      'both',
      'disable-model-invocation: true\nmetadata:\n  opencode/autoinvoke: "true"\n',
    ),
    'ws-one:.github/skills/quiet/SKILL.md': skill('quiet', 'disable-model-invocation: true\n'),
    'ws-one:.github/skills/plain/SKILL.md': skill('plain'),
  });
  h.llama.reply(call('skill', { name: 'deploy' }), { content: 'Cannot.' });
  const refused = await h.runtime.loop.send(h.thread.id, 'Deploy.', 'refused');
  expect(h.prompt(0)).toContain('- both: both description.');
  expect(h.prompt(0)).toContain('- plain: plain description.');
  expect(h.prompt(0)).not.toMatch(/- (deploy|quiet):/u);
  expect(h.tools(refused)[0]?.content).toContain(
    'Only the user can run this skill, by typing /deploy.',
  );

  const input = 'Ship with @deploy, mail me@quiet.dev or @nope, then (@plain).';
  h.llama.reply(call('skill', { name: 'deploy', resource: 'notes.md' }), {
    fail: 'Model crashed.',
  });
  await expect(h.runtime.loop.send(h.thread.id, input, 'mentions')).rejects.toThrow(
    'Model crashed.',
  );
  let thread = h.runtime.threads.get(h.thread.id);
  const turn = thread.messages.slice(
    thread.messages.findIndex((entry) => entry.id === 'user-mentions'),
  );
  expect(turn[0]).toMatchObject({ role: 'user', content: input });
  expect(
    turn[1]?.toolCalls?.map((entry) => [entry.id.split('-')[0], entry.function.arguments]),
  ).toEqual([
    ['mention', '{"name":"deploy"}'],
    ['mention', '{"name":"plain"}'],
  ]);
  expect(turn[2]).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('DEPLOY BODY'),
  });
  expect(turn[3]).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('PLAIN BODY'),
  });
  expect(turn[5]).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('DEPLOY NOTES'),
  });

  const reads = jest.spyOn(h.native, 'readWorkspaceFile');
  h.llama.reply(call('skill', { name: 'deploy', resource: 'notes.md' }), { content: 'Deployed.' });
  thread = await h.runtime.loop.retry(h.thread.id);
  expect(thread.status).toBe('complete');
  expect(
    thread.messages.filter((entry) =>
      entry.toolCalls?.some((item) => item.id.startsWith('mention-')),
    ),
  ).toHaveLength(1);
  expect(reads.mock.calls.filter(([, path]) => path.endsWith('SKILL.md'))).toHaveLength(0);
  expect(h.tools(thread).at(-1)).toMatchObject({ tool: { status: 'completed' } });

  h.llama.reply({ content: 'Noted.' });
  const limited = await h.runtime.loop.send(h.thread.id, '@both @plain @deploy @quiet', 'limit');
  const activated = limited.messages
    .slice(limited.messages.findIndex((entry) => entry.id === 'user-limit'))
    .find((entry) => entry.toolCalls?.length);
  expect(activated?.toolCalls?.map((entry) => entry.function.arguments)).toEqual([
    '{"name":"both"}',
    '{"name":"plain"}',
    '{"name":"deploy"}',
  ]);
  await h.runtime.dispose();
});

test('opencode.json(c) sources outrank project roots, project beats personal, and configured catalogs never download by themselves', async () => {
  const h = await harness({
    'ws-one:opencode.jsonc':
      '{\n  // team sources\n  "skills": ["./team-skills", "~/home-skills", "https://cat.example/skills",],\n}',
    'ws-one:.opencode/opencode.json': '{"skills": ["shared"]}',
    'ws-one:team-skills/review/SKILL.md': skill('review', '', 'TEAM REVIEW'),
    'ws-one:team-skills/lint.md': '---\ndescription: Team lint.\n---\nTEAM LINT',
    'ws-one:shared/review/SKILL.md': skill('review', '', 'SHARED REVIEW'),
    'ws-one:.opencode/skills/lint/SKILL.md': skill('lint', '', 'OPENCODE LINT'),
    'ws-one:.claude/skills/plan/SKILL.md': skill('plan'),
    'ws-one:library/plan/SKILL.md': skill('plan', '', 'PERSONAL PLAN'),
    'ws-one:library/notes/SKILL.md': skill('notes'),
  });
  const urls = serve(new Map());
  await h.runtime.skills.importPersonal('ws-one', 'library/plan');
  await h.runtime.skills.importPersonal('ws-one', 'library/notes');
  const listing = await h.runtime.skills.list('ws-one');
  expect(
    listing.skills.map((entry) => [entry.id, entry.sourceKind, entry.sourceRoot, entry.location]),
  ).toEqual([
    ['review', 'config-path', 'shared', 'shared/review'],
    ['lint', 'config-path', 'team-skills', 'team-skills/lint.md'],
    ['plan', 'project-root', '.claude/skills', '.claude/skills/plan'],
    ['notes', 'personal', 'personal', 'personal/notes'],
  ]);
  expect(listing.diagnostics.map((entry) => [entry.location, entry.message])).toEqual(
    expect.arrayContaining([
      ['opencode.jsonc', '~/home-skills: home and absolute paths are unavailable on iPhone.'],
      [
        'https://cat.example/skills/',
        'Not downloaded: the agent never downloads catalogs; download it in Settings.',
      ],
      ['team-skills/review', 'Shadowed by the project skill shared/review.'],
      ['.opencode/skills/lint', 'Shadowed by the project skill team-skills/lint.md.'],
      ['personal/plan', 'Shadowed by the project skill .claude/skills/plan.'],
    ]),
  );
  h.llama.reply(call('skill', { name: 'review' }), { content: 'Reviewed.' });
  const result = await h.runtime.loop.send(h.thread.id, 'Review.', 'config-sources');
  expect(h.tools(result)[0]?.content).toContain('SHARED REVIEW');
  expect(await h.runtime.skills.catalogs('ws-one')).toEqual([
    {
      url: 'https://cat.example/skills/',
      scope: 'project',
      file: 'opencode.jsonc',
      state: 'not-downloaded',
      skills: [],
      error: null,
    },
  ]);
  expect(urls()).toEqual([]);
  await h.runtime.dispose();
});

test('HTTPS catalogs download only on request, refresh by version, and reject unsafe, cross-origin, redirected, or oversized files', async () => {
  const base = 'https://cat.example/skills/';
  const routes = new Map<string, string | number>([
    [
      `${base}index.json`,
      JSON.stringify({
        skills: [
          { name: 'release', version: '1', files: ['release.md', 'references/guide.md'] },
          { name: 'escape', version: '1', files: ['SKILL.md', '../secret.md'] },
          { name: 'absolute', version: '1', files: ['SKILL.md', 'https://evil.example/x.md'] },
          { name: 'moved', version: '1', files: ['SKILL.md'] },
          { name: 'huge', version: '1', files: ['SKILL.md'] },
          { name: 'entryless', version: '1', files: ['README.md'] },
        ],
      }),
    ],
    [
      `${base}release/release.md`,
      '---\ndescription: Release from the catalog.\n---\nCATALOG RELEASE',
    ],
    [`${base}release/references/guide.md`, 'CATALOG GUIDE'],
    [`${base}moved/SKILL.md`, 302],
    [`${base}huge/SKILL.md`, 'x'.repeat(1024 * 1024 + 1)],
  ]);
  const h = await harness();
  const urls = serve(routes);
  expect(await h.runtime.skills.addPersonalCatalog('https://cat.example/skills')).toBe(base);
  expect(await h.runtime.skills.catalogs(null)).toMatchObject([
    { url: base, scope: 'personal', state: 'not-downloaded' },
  ]);
  await expect(h.runtime.skills.downloadCatalog(null, 'https://other.example/')).rejects.toThrow(
    'Add this catalog',
  );
  expect(urls()).toEqual([]);

  const first = await h.runtime.skills.downloadCatalog(null, base);
  expect(first.skills.map((entry) => [entry.name, entry.status, entry.error ?? ''])).toEqual([
    ['release', 'downloaded', ''],
    ['escape', 'failed', expect.stringContaining('inside the workspace')],
    ['absolute', 'failed', expect.stringContaining('plain, and relative')],
    ['moved', 'failed', expect.stringContaining('HTTP 302; catalog redirects are not followed')],
    ['huge', 'failed', expect.stringContaining('1 MiB')],
    ['entryless', 'failed', 'The catalog must list SKILL.md or entryless.md.'],
  ]);
  expect(urls().every((url) => url.startsWith(base))).toBe(true);
  expect(await h.runtime.skills.catalogs(null)).toEqual([
    {
      url: base,
      scope: 'personal',
      file: null,
      state: 'failed',
      skills: [{ name: 'release', version: '1' }],
      error: expect.stringContaining('escape:'),
    },
  ]);
  const listing = await h.runtime.skills.list('ws-one');
  expect(listing.skills).toMatchObject([
    {
      id: 'release',
      source: 'personal',
      sourceKind: 'catalog',
      sourceRoot: base,
      layout: 'flat',
      advertised: true,
    },
  ]);
  h.llama.reply(
    call('skill', { name: 'release' }),
    call('skill', { name: 'release', resource: 'references/guide.md' }),
    { content: 'Released.' },
  );
  const used = await h.runtime.loop.send(h.thread.id, 'Release.', 'catalog-use');
  expect(h.prompt(0)).toContain('- release: Release from the catalog.');
  expect(h.output(h.tools(used)[0])).toMatchObject({
    content: expect.stringContaining('CATALOG RELEASE'),
    files: ['references/guide.md'],
  });
  expect(h.output(h.tools(used)[1])).toMatchObject({ content: 'CATALOG GUIDE' });

  const before = urls().length;
  const again = await h.runtime.skills.downloadCatalog(null, base);
  expect(again.skills[0]).toMatchObject({ name: 'release', status: 'unchanged' });
  expect(
    urls()
      .slice(before)
      .filter((url) => url.includes('/release/')),
  ).toEqual([]);

  routes.set(
    `${base}index.json`,
    JSON.stringify({ skills: [{ name: 'release', version: 2, files: ['SKILL.md'] }] }),
  );
  routes.set(`${base}release/SKILL.md`, '---\ndescription: Release v2.\n---\nCATALOG RELEASE V2');
  expect((await h.runtime.skills.downloadCatalog(null, base)).skills).toEqual([
    { name: 'release', version: '2', status: 'downloaded' },
  ]);
  expect(await h.runtime.skills.catalogs(null)).toMatchObject([
    { state: 'cached', skills: [{ name: 'release', version: '2' }], error: null },
  ]);
  expect((await h.runtime.skills.list('ws-one')).skills).toMatchObject([
    { id: 'release', layout: 'directory', description: 'Release v2.' },
  ]);

  await h.runtime.skills.removePersonalCatalog(base);
  expect((await h.runtime.skills.list('ws-one')).skills).toEqual([]);
  expect([...h.documents.keys()].some((name) => name.startsWith('skillcat-'))).toBe(false);
  expect(h.runtime.preferences().skillCatalogs).toEqual([]);
  await h.runtime.dispose();
});

test('catalog downloads time out, respect offline checks, and need a workspace-listed URL', async () => {
  const llama = new FakeLlama();
  const fake = createFakeOnDeviceNative(llama, {
    files: { 'ws-one:opencode.json': '{"skills": ["https://slow.example/skills/"]}' },
    workspaces: [{ id: 'ws-one', name: 'One', isRepository: true }],
  });
  let offline = false;
  const request = jest.fn(
    (_url: string, init: RequestInit) =>
      new Promise<never>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  );
  const skills = new LocalSkills(fake.native, null, () => undefined, {
    request,
    timeoutMs: 20,
    requireNetwork: () => {
      if (offline) {
        throw new Error('You are offline. Connect to download skill catalogs.');
      }
    },
  });
  await expect(skills.downloadCatalog('ws-one', 'https://slow.example/skills')).rejects.toThrow(
    'timed out after 0.02 seconds',
  );
  expect(await skills.catalogs('ws-one')).toMatchObject([
    {
      scope: 'project',
      file: 'opencode.json',
      state: 'failed',
      error: expect.stringContaining('timed out'),
    },
  ]);
  offline = true;
  request.mockClear();
  await expect(skills.downloadCatalog('ws-one', 'https://slow.example/skills/')).rejects.toThrow(
    'offline',
  );
  expect(request).not.toHaveBeenCalled();
  await expect(skills.downloadCatalog(null, 'https://slow.example/skills/')).rejects.toThrow(
    'Add this catalog',
  );
});

test('OpenCode skill permissions: wildcards and last match, per-agent rules, tools.skill false, and device-owner rules last', async () => {
  const files: Record<string, string> = {
    'ws-one:opencode.json': JSON.stringify({
      permission: { skill: { '*': 'allow', 'internal-*': 'deny', 'exp-?': 'ask' } },
      permissions: [{ action: 'skill', resource: 'internal-docs', effect: 'allow' }],
      agent: {
        explore: { tools: { skill: false } },
        general: { permission: { skill: { review: 'deny' } } },
      },
      agents: { build: { permissions: [{ action: 'skill', resource: 'secret', effect: 'deny' }] } },
    }),
  };
  for (const name of ['review', 'internal-docs', 'internal-tools', 'exp-a', 'exp-ab', 'secret']) {
    files[`ws-one:.agents/skills/${name}/SKILL.md`] = skill(name);
  }
  const h = await harness(files);
  const listing = await h.runtime.skills.list('ws-one');
  expect(
    listing.skills.map((entry) => [
      entry.id,
      entry.permission.effect,
      entry.permission.rule?.origin ?? null,
      entry.enabled,
      entry.advertised,
    ]),
  ).toEqual([
    ['exp-a', 'ask', 'opencode.json permission.skill', true, true],
    ['exp-ab', 'allow', 'opencode.json permission.skill', true, true],
    ['internal-docs', 'allow', 'opencode.json permissions[0]', true, true],
    ['internal-tools', 'deny', 'opencode.json permission.skill', false, false],
    ['review', 'allow', 'opencode.json permission.skill', true, true],
    ['secret', 'deny', 'opencode.json agents.build.permissions[0]', false, false],
  ]);
  expect(h.runtime.skills.commands('ws-one').map((command) => command.name)).toEqual([
    'exp-a',
    'exp-ab',
    'internal-docs',
    'review',
  ]);
  h.llama.reply({ content: 'Plain.' });
  const plain = await h.runtime.loop.send(h.thread.id, '/internal-tools now @secret', 'denied');
  expect(h.tools(plain)).toEqual([]);
  expect(h.prompt(0)).not.toMatch(/- (internal-tools|secret):/u);
  expect(h.prompt(0)).toContain('- review:');

  h.llama.reply(
    call('task', { tasks: [{ agent: 'general', prompt: 'Review with the skill.' }] }),
    call('skill', { name: 'review' }),
    { content: 'General could not.' },
    call('task', { tasks: [{ agent: 'explore', prompt: 'Look around.' }] }),
    call('skill', { name: 'internal-docs' }),
    { content: 'Explore could not.' },
    { content: 'Parent done.' },
  );
  const delegated = await h.runtime.loop.send(h.thread.id, 'Delegate.', 'agents');
  expect(h.prompt(2)).not.toContain('- review:');
  expect(h.prompt(2)).toContain('- internal-docs:');
  expect(h.advertised(2)).toContain('skill');
  const [general, explore] = h.tools(delegated).map((entry) => entry.children?.[0]);
  expect(general?.messages.find((entry) => entry.tool)?.content).toContain(
    'No enabled skill is named \\"review\\"',
  );
  expect(h.prompt(5)).not.toContain('Skills (');
  expect(h.advertised(5)).not.toContain('skill');
  expect(explore?.messages.find((entry) => entry.tool)?.content).toContain(
    'Skills are turned off for this agent.',
  );

  await h.runtime.skills.setRules([
    { pattern: 'internal-*', effect: 'allow' },
    { pattern: 'secret', effect: 'allow' },
    { pattern: 'exp-*', effect: 'deny' },
  ]);
  await h.runtime.skills.setEnabled('review', false);
  const owned = await h.runtime.skills.list('ws-one');
  expect(
    owned.skills.map((entry) => [
      entry.id,
      entry.permission.effect,
      entry.permission.rule?.origin ?? null,
    ]),
  ).toEqual([
    ['exp-a', 'deny', 'user'],
    ['exp-ab', 'deny', 'user'],
    ['internal-docs', 'allow', 'user'],
    ['internal-tools', 'allow', 'user'],
    ['review', 'deny', 'user'],
    ['secret', 'allow', 'user'],
  ]);
  expect(h.runtime.skills.commands('ws-one').map((command) => command.name)).toEqual([
    'internal-docs',
    'internal-tools',
    'secret',
  ]);
  await h.runtime.skills.setEnabled('exp-a', true);
  expect(h.runtime.skills.rules().at(-1)).toEqual({ pattern: 'exp-a', effect: 'allow' });
  expect(h.runtime.skills.enabled('exp-a')).toBe(true);
  expect(h.runtime.skills.enabled('exp-ab')).toBe(false);
  await h.runtime.flush();
  const saved = JSON.parse(h.documents.get('preferences.json') ?? '{}') as Record<string, unknown>;
  expect(saved).toMatchObject({
    disabledSkills: ['review'],
    skillRules: expect.arrayContaining([{ pattern: 'exp-a', effect: 'allow' }]),
  });
  await expect(h.runtime.skills.setRules([{ pattern: '', effect: 'allow' }])).rejects.toThrow(
    '1-128',
  );
  await h.runtime.dispose();

  const reloaded = await harness(files, Object.fromEntries(h.documents));
  expect(reloaded.runtime.skills.rules()).toEqual(h.runtime.skills.rules());
  expect(
    (await reloaded.runtime.skills.list('ws-one')).skills.map((entry) => entry.permission.effect),
  ).toEqual(['allow', 'deny', 'allow', 'allow', 'deny', 'allow']);
  await reloaded.runtime.dispose();
});

test('ask skills need the real approval flow for model loads; user-named loads count as consent', async () => {
  const h = await harness({
    'ws-one:opencode.json': '{"permission": {"skill": {"exp-*": "ask"}}}',
    'ws-one:.agents/skills/exp-a/SKILL.md': skill('exp-a'),
    'ws-one:.agents/skills/exp-a/notes.md': 'EXP NOTES',
  });
  h.runtime.loop.setApprovalPolicy('on-request');
  h.llama.reply(
    call('skill', { name: 'exp-a' }),
    call('skill', { name: 'exp-a', resource: 'notes.md' }),
    { content: 'Done.' },
  );
  const running = h.runtime.loop.send(h.thread.id, 'Experiment.', 'ask-approve');
  await until(() => h.runtime.loop.snapshot().approval !== null);
  const approval = h.runtime.loop.snapshot().approval;
  expect(approval).toMatchObject({
    toolName: 'skill',
    kind: 'other',
    summary: 'Load the exp-a skill',
  });
  h.runtime.loop.resolveApproval(approval?.callId ?? '', true);
  const approved = await running;
  expect(h.tools(approved).map((entry) => entry.tool.status)).toEqual(['completed', 'completed']);
  expect(h.tools(approved)[1]?.content).toContain('EXP NOTES');

  h.llama.reply(call('skill', { name: 'exp-a' }), { content: 'Declined.' });
  const declining = h.runtime.loop.send(h.thread.id, 'Again.', 'ask-decline');
  await until(() => h.runtime.loop.snapshot().approval !== null);
  h.runtime.loop.resolveApproval(h.runtime.loop.snapshot().approval?.callId ?? '', false);
  expect(h.tools(await declining).at(-1)?.content).toContain('The user declined this request');

  h.llama.reply({ content: 'Slash loaded.' });
  const slashed = await h.runtime.loop.send(h.thread.id, '/exp-a', 'ask-slash');
  expect(h.tools(slashed).at(-1)).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('EXP-A BODY'),
  });

  h.runtime.loop.setApprovalPolicy('never');
  h.llama.reply(call('skill', { name: 'exp-a' }), { content: 'Auto.' });
  const automatic = await h.runtime.loop.send(h.thread.id, 'Auto.', 'ask-never');
  expect(h.tools(automatic).at(-1)).toMatchObject({ tool: { status: 'completed' } });
  await h.runtime.dispose();
});

test('the global switch turns skills off: no catalog, tool, slash commands, or mentions', async () => {
  const h = await harness({ 'ws-one:.github/skills/review/SKILL.md': skill('review') });
  await h.runtime.skills.list('ws-one');
  expect(h.runtime.skills.commands('ws-one')).toHaveLength(1);
  await h.runtime.skills.setSkillsEnabled(false);
  expect(h.runtime.skills.skillsEnabled()).toBe(false);
  expect(h.runtime.preferences().skillsEnabled).toBe(false);
  expect(h.runtime.skills.commands('ws-one')).toEqual([]);
  expect((await h.runtime.skills.list('ws-one')).skills).toMatchObject([
    { id: 'review', enabled: true, advertised: false },
  ]);
  h.llama.reply(call('skill', { name: 'review' }), { content: 'Off.' });
  const off = await h.runtime.loop.send(h.thread.id, '/review and @review', 'off');
  expect(h.prompt(0)).not.toContain('Skills (');
  expect(h.advertised(0)).not.toContain('skill');
  expect(h.tools(off)).toHaveLength(1);
  expect(h.tools(off)[0]?.content).toContain('Skills are turned off for this agent.');
  await h.runtime.flush();
  const reloaded = await harness({}, Object.fromEntries(h.documents));
  expect(reloaded.runtime.skills.skillsEnabled()).toBe(false);
  await reloaded.runtime.dispose();
  await h.runtime.skills.setSkillsEnabled(true);
  expect(h.runtime.skills.commands('ws-one')).toHaveLength(1);
  await h.runtime.dispose();
});

test('two ask skill loads in one reply are asked one at a time and the turn completes; allowed loads still run in parallel', async () => {
  const h = await harness({
    'ws-one:opencode.json': '{"permission": {"skill": {"*": "ask", "free-*": "allow"}}}',
    'ws-one:.agents/skills/alpha/SKILL.md': skill('alpha'),
    'ws-one:.agents/skills/beta/SKILL.md': skill('beta'),
    'ws-one:.agents/skills/free-a/SKILL.md': skill('free-a'),
    'ws-one:.agents/skills/free-b/SKILL.md': skill('free-b'),
  });
  h.runtime.loop.setApprovalPolicy('on-request');
  h.llama.reply(
    {
      toolCalls: [
        { name: 'skill', arguments: { name: 'alpha' } },
        { name: 'skill', arguments: { name: 'beta' } },
      ],
    },
    { content: 'Both loaded.' },
  );
  const running = h.runtime.loop.send(h.thread.id, 'Load both.', 'two-asks');
  const answered: string[] = [];
  for (const expected of ['alpha', 'beta']) {
    await until(() => {
      const pending = h.runtime.loop.snapshot().approval;
      return pending !== null && !answered.includes(pending.callId);
    });
    const approval = h.runtime.loop.snapshot().approval;
    expect(approval).toMatchObject({ toolName: 'skill', summary: `Load the ${expected} skill` });
    answered.push(approval?.callId ?? '');
    h.runtime.loop.resolveApproval(approval?.callId ?? '', true);
  }
  const asked = await running;
  expect(asked.status).toBe('complete');
  expect(h.tools(asked).map((entry) => [entry.tool.status, h.output(entry)['name']])).toEqual([
    ['completed', 'alpha'],
    ['completed', 'beta'],
  ]);

  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = h.native.readWorkspaceFile;
  const rounds = h.generate.mock.calls.length;
  jest.spyOn(h.native, 'readWorkspaceFile').mockImplementation(async (id, path, offset, limit) => {
    if (path.endsWith('free-a/SKILL.md') && h.generate.mock.calls.length > rounds) {
      await held;
    }
    return read(id, path, offset, limit);
  });
  h.llama.reply(
    {
      toolCalls: [
        { name: 'skill', arguments: { name: 'free-a' } },
        { name: 'skill', arguments: { name: 'free-b' } },
      ],
    },
    { content: 'Free loaded.' },
  );
  const parallel = h.runtime.loop.send(h.thread.id, 'Load the free ones.', 'parallel');
  // free-b finishes while free-a is still held: the two allowed loads were batched.
  await until(() => h.tools().at(-1)?.tool.status === 'completed' && h.tools().length === 4);
  expect(h.tools().at(-2)?.tool.status).toBe('running');
  release();
  expect((await parallel).status).toBe('complete');
  await h.runtime.dispose();
});

test('a context: fork load needs the general child it runs in: deny or tools.skill false refuses before any child runs', async () => {
  const configs = {
    deny: { agent: { general: { permission: { skill: { audit: 'deny' } } } } },
    tools: { agent: { general: { tools: { skill: false } } } },
    v2: {
      agents: { general: { permissions: [{ action: 'skill', resource: '*', effect: 'deny' }] } },
    },
  };
  for (const [label, config] of Object.entries(configs)) {
    const h = await harness({
      'ws-one:opencode.json': JSON.stringify(config),
      'ws-one:.agents/skills/audit/SKILL.md': skill('audit', 'context: fork\n'),
    });
    h.llama.reply(call('skill', { name: 'audit' }), { content: 'Refused.' });
    const result = await h.runtime.loop.send(h.thread.id, 'Audit.', `fork-${label}`);
    expect(h.tools(result)[0]).toMatchObject({
      tool: { status: 'failed' },
      content: expect.stringContaining('runs in a general child'),
    });
    expect(h.tools(result)[0]?.children).toBeUndefined();
    h.llama.reply({ content: 'Still refused.' });
    const slash = await h.runtime.loop.send(h.thread.id, '/audit now', `fork-${label}-slash`);
    expect(h.tools(slash).at(-1)?.content).toContain('runs in a general child');
    expect(h.tools(slash).some((entry) => entry.children)).toBe(false);
    expect(h.generate).toHaveBeenCalledTimes(3);
    await h.runtime.dispose();
  }
});

test("a model's context: fork load asks when the general child's rules ask; the user's /id is consent", async () => {
  const h = await harness({
    'ws-one:opencode.json': JSON.stringify({
      agents: { general: { permissions: [{ action: 'skill', resource: 'audit', effect: 'ask' }] } },
    }),
    'ws-one:.agents/skills/audit/SKILL.md': skill('audit', 'context: fork\n', 'AUDIT BODY'),
  });
  h.runtime.loop.setApprovalPolicy('on-request');
  h.llama.reply(
    call('skill', { name: 'audit', prompt: 'the parser' }),
    { content: 'Child finding.' },
    { content: 'Parent summary.' },
  );
  const running = h.runtime.loop.send(h.thread.id, 'Audit the parser.', 'fork-ask');
  await until(() => h.runtime.loop.snapshot().approval !== null);
  expect(h.runtime.loop.snapshot().approval).toMatchObject({
    toolName: 'skill',
    summary: 'Load the audit skill',
  });
  expect(h.generate).toHaveBeenCalledTimes(1);
  h.runtime.loop.resolveApproval(h.runtime.loop.snapshot().approval?.callId ?? '', true);
  const approved = await running;
  expect(h.output(h.tools(approved)[0])).toMatchObject({
    context: 'fork',
    agent: 'general',
    summary: 'Child finding.',
  });

  h.llama.reply(call('skill', { name: 'audit' }), { content: 'Declined.' });
  const declining = h.runtime.loop.send(h.thread.id, 'Audit again.', 'fork-ask-decline');
  await until(() => h.runtime.loop.snapshot().approval !== null);
  h.runtime.loop.resolveApproval(h.runtime.loop.snapshot().approval?.callId ?? '', false);
  const declined = await declining;
  expect(h.tools(declined).at(-1)).toMatchObject({
    content: expect.stringContaining('The user declined this request'),
  });
  expect(h.tools(declined).at(-1)?.children).toBeUndefined();

  h.llama.reply({ content: 'User child.' }, { content: 'Parent after slash.' });
  const slashed = await h.runtime.loop.send(h.thread.id, '/audit the lexer', 'fork-ask-slash');
  expect(slashed.status).toBe('complete');
  expect(h.output(h.tools(slashed).at(-1))).toMatchObject({
    context: 'fork',
    agent: 'general',
    summary: 'User child.',
  });
  await h.runtime.dispose();
});

test('a /skill message over the 32,768-character prompt limit loads inline skills and gives fork children a bounded request', async () => {
  const diff = 'd'.repeat(40_000);
  const h = await harness({
    'ws-one:.github/skills/review/SKILL.md': skill('review'),
    'ws-one:.github/skills/audit/SKILL.md': skill('audit', 'context: fork\n'),
  });
  const note = '\n[Request truncated to 32768 characters.]';
  // A 40 KB message must fit the fake model's window; the limit under test is the skill call's.
  h.llama.charactersPerToken = 64;
  h.llama.reply({ content: 'Reviewed.' });
  const inline = await h.runtime.loop.send(h.thread.id, `/review ${diff}`, 'long-inline');
  expect(inline.messages.find((entry) => entry.id === 'user-long-inline')?.content).toBe(
    `/review ${diff}`,
  );
  const slash = inline.messages.find((entry) => entry.toolCalls?.[0]?.id.startsWith('slash-'));
  const prompt = (
    JSON.parse(slash?.toolCalls?.[0]?.function.arguments ?? '{}') as { prompt: string }
  ).prompt;
  expect(prompt).toHaveLength(32_768);
  expect(prompt.endsWith(note)).toBe(true);
  expect(h.tools(inline)[0]).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('REVIEW BODY'),
  });

  h.llama.reply({ content: 'Child audit.' }, { content: 'Parent audit.' });
  const forked = await h.runtime.loop.send(h.thread.id, `/audit ${diff}`, 'long-fork');
  const result = h.tools(forked).at(-1);
  expect(h.output(result)).toMatchObject({ context: 'fork', summary: 'Child audit.' });
  const request = result?.children?.[0]?.messages[0]?.content ?? '';
  expect(request).toContain(note.trim());
  expect(request.length).toBeLessThan(34_000);
  await h.runtime.dispose();
});
