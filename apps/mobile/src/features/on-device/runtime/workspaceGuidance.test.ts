import { randomUUID } from 'expo-crypto';
import { localModelDefinition } from '../models/catalog';
import { modelMemoryBytes } from '../models/memory';
import { loadNativeModelContext } from '../models/engine';
import { LocalModelInterrupted, LocalModelSession } from '../models/session';
import { OnDeviceNativeError } from '../native/services.errors';
import { LocalAgentLoop } from './agentLoop';
import { LOCAL_TOOL_DEFINITIONS, localToolApproval } from './localTools';
import { OnDeviceRuntime } from './runtime';
import { createFakeOnDeviceNative, FakeLlama } from './testing';
import { toolDefinition } from './toolDefinition';
import { GUIDANCE_FILE_BYTES, LocalWorkspaceGuidance } from './workspaceGuidance';
import { LocalSkills } from './skills';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const modelId = 'qwen3-1.7b-q4-k-m';
const skillId = '.agents/skills/review';
const skill = (
  name = 'review',
  description = 'Review local changes.',
  body = 'PRIVATE FULL SKILL BODY',
) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

beforeEach(() => {
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
});

async function harness(files: Record<string, string> = {}) {
  const llama = new FakeLlama();
  jest.mocked(loadNativeModelContext).mockImplementation(llama.loader);
  const fake = createFakeOnDeviceNative(llama, {
    downloaded: [modelId],
    files,
    workspaces: [
      { id: 'ws-one', name: 'One', isRepository: true },
      { id: 'ws-two', name: 'Two', isRepository: true },
    ],
  });
  const runtime = new OnDeviceRuntime(fake.native, { emitIntervalMs: 0 });
  await runtime.initialize();
  const thread = await runtime.threads.create('ws-one', modelId);
  const generate = jest.spyOn(runtime.models, 'generate');
  const prompt = (round: number) => generate.mock.calls[round]?.[0][0]?.content ?? '';
  return { ...fake, llama, runtime, thread, generate, prompt };
}

function readBarrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, pending, enter, release };
}

test('real model rounds load root then relevant nested rules before a path tool can run', async () => {
  const h = await harness({
    'ws-one:AGENTS.md': 'ROOT: use two spaces.',
    'ws-one:CLAUDE.md': 'IGNORED root fallback',
    'ws-one:src/AGENTS.md': 'SRC: use four spaces here.',
    'ws-one:src/deep/CLAUDE.md': 'DEEP: use tabs here.',
    'ws-one:other/AGENTS.md': 'UNRELATED SIBLING',
    'ws-one:src/deep/file.txt': 'actual contents',
  });
  const call = { name: 'read_file', arguments: { path: 'src/deep/file.txt' } };
  h.llama.reply({ toolCalls: [call] }, { toolCalls: [call] }, { content: 'Done.' });
  const result = await h.runtime.loop.send(h.thread.id, 'Read src/deep/file.txt', 'nested');
  expect(result.status).toBe('complete');
  expect(h.prompt(0)).toContain('ROOT: use two spaces.');
  expect(h.prompt(0)).not.toContain('SRC: use four');
  const nested = h.prompt(1);
  expect(nested.indexOf('ROOT: use two')).toBeLessThan(nested.indexOf('SRC: use four'));
  expect(nested.indexOf('SRC: use four')).toBeLessThan(nested.indexOf('DEEP: use tabs'));
  expect(nested).toContain('deeper rules override ancestor rules there, not in sibling');
  expect(nested).not.toMatch(/IGNORED|UNRELATED/);
  expect(h.prompt(2)).toContain('DEEP: use tabs');
  const tools = result.messages.filter((entry) => entry.tool);
  expect(tools[0]).toMatchObject({
    tool: { status: 'failed' },
    content: expect.stringContaining('Not run'),
  });
  expect(tools[1]).toMatchObject({
    tool: { status: 'completed' },
    content: expect.stringContaining('actual contents'),
  });
  expect(
    h.calls.filter((call) => call === 'readWorkspaceFile:["ws-one","src/deep/file.txt"]'),
  ).toHaveLength(1);
  await h.runtime.dispose();
});

test.each([
  'code_diagnostics',
  'code_definitions',
  'code_references',
  'code_symbols',
  'format_file',
])('code path scopes fence %s until ancestor rules have been supplied', async (name) => {
  const h = await harness({
    'ws-one:AGENTS.md': 'ROOT RULE',
    'ws-one:src/AGENTS.md': 'SRC RULE',
    'ws-one:src/deep/AGENTS.md': 'DEEP RULE',
  });
  const guidance = new LocalWorkspaceGuidance(h.native, new LocalSkills(h.native));
  const state = { directories: new Set(['']), rules: '' };
  const signal = new AbortController().signal;
  await guidance.prompt('ws-one', state, 8192, signal);
  await expect(
    guidance.beforeTool('ws-one', state, name, { path: 'src/deep/file.ts' }, signal),
  ).rejects.toThrow('Not run');
  const refreshed = await guidance.prompt('ws-one', state, 8192, signal);
  expect(refreshed.content.indexOf('ROOT RULE')).toBeLessThan(
    refreshed.content.indexOf('SRC RULE'),
  );
  expect(refreshed.content.indexOf('SRC RULE')).toBeLessThan(
    refreshed.content.indexOf('DEEP RULE'),
  );
  await expect(
    guidance.beforeTool('ws-one', state, name, { path: 'src/deep/file.ts' }, signal),
  ).resolves.toBeUndefined();
  await h.runtime.dispose();
});

test.each([
  [0, 'alpha'],
  [0, 'beta'],
  [22, 'alpha'],
  [22, 'beta'],
] as const)(
  'parallel sibling reads merge bounded scopes (seeded %i, first %s)',
  async (seeded, firstName) => {
    const h = await harness({
      'ws-one:AGENTS.md': 'ROOT PARALLEL RULE',
      'ws-one:alpha/AGENTS.md': 'ALPHA PARALLEL RULE',
      'ws-one:beta/AGENTS.md': 'BETA PARALLEL RULE',
      'ws-one:alpha/file.txt': 'alpha contents',
      'ws-one:beta/file.txt': 'beta contents',
    });
    const guidance = new LocalWorkspaceGuidance(h.native, new LocalSkills(h.native));
    const initial = ['', ...Array.from({ length: seeded }, (_, index) => `seed-${String(index)}`)];
    const state = { directories: new Set(initial), rules: '' };
    const signal = new AbortController().signal;
    await guidance.prompt('ws-one', state, 8192, signal);
    const barriers = { alpha: readBarrier(), beta: readBarrier() };
    const original = h.native.readWorkspaceFile;
    jest
      .spyOn(h.native, 'readWorkspaceFile')
      .mockImplementation(async (id, path, offset, limit) => {
        const barrier =
          path === 'alpha/AGENTS.md'
            ? barriers.alpha
            : path === 'beta/AGENTS.md'
              ? barriers.beta
              : null;
        if (barrier) {
          barrier.enter();
          await barrier.pending;
        }
        return original(id, path, offset, limit);
      });
    const calls = {
      alpha: guidance.beforeTool('ws-one', state, 'read_file', { path: 'alpha/file.txt' }, signal),
      beta: guidance.beforeTool('ws-one', state, 'read_file', { path: 'beta/file.txt' }, signal),
    };
    const settled = Promise.allSettled([calls.alpha, calls.beta]);
    await Promise.all([barriers.alpha.entered, barriers.beta.entered]);
    expect(state.directories).toEqual(new Set(initial));
    barriers[firstName].release();
    await expect(calls[firstName]).rejects.toThrow('Not run');
    expect(state.directories).toEqual(new Set([...initial, firstName]));
    const lastName = firstName === 'alpha' ? 'beta' : 'alpha';
    barriers[lastName].release();
    await settled;
    if (seeded === 22) {
      await expect(calls[lastName]).rejects.toThrow('24-directory limit');
      expect(state.directories).toEqual(new Set([...initial, firstName]));
      expect(state.directories.size).toBe(24);
    } else {
      await expect(calls[lastName]).rejects.toThrow('Not run');
      expect(state.directories).toEqual(new Set(['', 'alpha', 'beta']));
    }
    const refreshed = await guidance.prompt('ws-one', state, 8192, signal);
    expect(refreshed.content).toContain(`${firstName.toUpperCase()} PARALLEL RULE`);
    if (seeded === 22) {
      expect(refreshed.content).not.toContain(`${lastName.toUpperCase()} PARALLEL RULE`);
    } else {
      expect(refreshed.content).toContain('ALPHA PARALLEL RULE');
      expect(refreshed.content).toContain('BETA PARALLEL RULE');
      const reads = await Promise.all(
        ['alpha', 'beta'].map(async (directory) => {
          const path = `${directory}/file.txt`;
          await guidance.beforeTool('ws-one', state, 'read_file', { path }, signal);
          return h.native.readWorkspaceFile('ws-one', path, 0, 1024);
        }),
      );
      expect(reads.map((read) => read.content)).toEqual(['alpha contents', 'beta contents']);
    }
    await h.runtime.dispose();
  },
);

test.each(['error', 'cancel'])(
  'parallel scope failure preserves completed scopes and explicit %s',
  async (outcome) => {
    const h = await harness({
      'ws-one:AGENTS.md': 'ROOT PARALLEL RULE',
      'ws-one:alpha/AGENTS.md': 'ALPHA SURVIVES',
      'ws-one:beta/AGENTS.md': 'BETA MUST NOT ENTER',
    });
    const guidance = new LocalWorkspaceGuidance(h.native, new LocalSkills(h.native));
    const state = { directories: new Set(['']), rules: '' };
    const controller = new AbortController();
    await guidance.prompt('ws-one', state, 8192, controller.signal);
    const gate = readBarrier();
    const failure = new OnDeviceNativeError('STORAGE_FAILURE', 'Sibling rules became unreadable.');
    const original = h.native.readWorkspaceFile;
    jest
      .spyOn(h.native, 'readWorkspaceFile')
      .mockImplementation(async (id, path, offset, limit) => {
        if (path === 'beta/AGENTS.md') {
          gate.enter();
          await gate.pending;
          if (outcome === 'error') {
            throw failure;
          }
        }
        return original(id, path, offset, limit);
      });
    const alpha = guidance.beforeTool(
      'ws-one',
      state,
      'read_file',
      { path: 'alpha/file.txt' },
      controller.signal,
    );
    const beta = guidance.beforeTool(
      'ws-one',
      state,
      'read_file',
      { path: 'beta/file.txt' },
      controller.signal,
    );
    const settled = Promise.allSettled([alpha, beta]);
    await gate.entered;
    await expect(alpha).rejects.toThrow('Not run');
    expect(state.directories).toEqual(new Set(['', 'alpha']));
    if (outcome === 'cancel') {
      controller.abort();
    }
    gate.release();
    await settled;
    if (outcome === 'error') {
      await expect(beta).rejects.toBe(failure);
    } else {
      await expect(beta).rejects.toBeInstanceOf(LocalModelInterrupted);
    }
    expect(state.directories).toEqual(new Set(['', 'alpha']));
    const refreshed = await guidance.prompt('ws-one', state, 8192, new AbortController().signal);
    expect(refreshed.content).toContain('ALPHA SURVIVES');
    expect(refreshed.content).not.toContain('BETA MUST NOT ENTER');
    await h.runtime.dispose();
  },
);

test('format mutation cannot run until the real loop supplies deeper rules to a subsequent model round', async () => {
  const path = 'src/deep/file.ts';
  const h = await harness({
    'ws-one:AGENTS.md': 'ROOT FORMATTING RULE',
    'ws-one:src/AGENTS.md': 'SRC FORMATTING RULE',
    'ws-one:src/deep/AGENTS.md': 'DEEP FORMATTING RULE: use two spaces.',
    [`ws-one:${path}`]: 'const value=1;',
  });
  const write = jest.spyOn(h.native, 'writeWorkspaceFile');
  const execute = jest.fn(async (workspace: string, name: string, input: unknown) => {
    expect(name).toBe('format_file');
    expect(input).toEqual({ path });
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect(h.prompt(1)).toContain('DEEP FORMATTING RULE: use two spaces.');
    const observed = await h.native.readWorkspaceFile(workspace, path, 0, 1024);
    const revision = await h.native.writeWorkspaceFile(
      workspace,
      path,
      'const value = 1;\n',
      observed.revision,
    );
    return { path, revision };
  });
  const definition = toolDefinition(
    'format_file',
    'Format a workspace file.',
    { path: { type: 'string' } },
    ['path'],
    { kind: 'edit', approval: null },
  );
  const loop = new LocalAgentLoop(
    h.runtime.threads,
    h.runtime.models,
    [...LOCAL_TOOL_DEFINITIONS, definition.definition],
    execute,
    jest.fn(),
    (name, input) => (name === 'format_file' ? null : localToolApproval(name, input)),
    undefined,
    new LocalWorkspaceGuidance(h.native, new LocalSkills(h.native)),
  );
  const generate = LocalModelSession.prototype.generate.bind(h.runtime.models);
  h.generate.mockImplementation(async (...args) => {
    if (h.generate.mock.calls.length <= 2) {
      expect(write).not.toHaveBeenCalled();
      expect(h.files.get(`ws-one:${path}`)).toBe('const value=1;');
    }
    return generate(...args);
  });
  const call = { name: 'format_file', arguments: { path } };
  h.llama.reply({ toolCalls: [call] }, { toolCalls: [call] }, { content: 'Formatted.' });
  const result = await loop.send(h.thread.id, 'Format src/deep/file.ts.', 'format-scope');
  expect(result.status).toBe('complete');
  expect(h.prompt(0)).not.toContain('DEEP FORMATTING RULE');
  const refreshed = h.prompt(1);
  expect(refreshed.indexOf('ROOT FORMATTING RULE')).toBeLessThan(
    refreshed.indexOf('SRC FORMATTING RULE'),
  );
  expect(refreshed.indexOf('SRC FORMATTING RULE')).toBeLessThan(
    refreshed.indexOf('DEEP FORMATTING RULE'),
  );
  expect(result.messages.filter((entry) => entry.tool).map((entry) => entry.tool?.status)).toEqual([
    'failed',
    'completed',
  ]);
  expect(result.messages.find((entry) => entry.tool)?.content).toContain('Not run');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(h.files.get(`ws-one:${path}`)).toBe('const value = 1;\n');
  await h.runtime.dispose();
});

test('scope fencing also protects a later edit in a multi-call round without losing observed revisions', async () => {
  const h = await harness({
    'ws-one:AGENTS.md': 'Root instructions.',
    'ws-one:src/AGENTS.md': 'Nested instructions.',
    'ws-one:file.txt': 'before',
  });
  const write = jest.spyOn(h.native, 'writeWorkspaceFile');
  const edit = jest.spyOn(h.native, 'editWorkspaceFile');
  const nestedWrite = { name: 'write_file', arguments: { path: 'src/new.txt', content: 'new' } };
  h.llama.reply(
    { toolCalls: [{ name: 'read_file', arguments: { path: 'file.txt' } }, nestedWrite] },
    {
      toolCalls: [
        nestedWrite,
        {
          name: 'edit_file',
          arguments: { path: 'file.txt', old_text: 'before', new_text: 'after' },
        },
      ],
    },
    { content: 'Done.' },
  );
  await h.runtime.loop.send(h.thread.id, 'Make the requested edits.', 'batch');
  expect(h.prompt(1)).toContain('Nested instructions.');
  expect(write).toHaveBeenCalledTimes(1);
  expect(edit).toHaveBeenCalledWith('ws-one', 'file.txt', 'before', 'after', 'rev-6');
  await h.runtime.dispose();
});

test.each(['rename_path', 'delete_path'])(
  'directory %s loads its own rules and rename destination ancestors before running',
  async (name) => {
    const h = await harness({
      'ws-one:AGENTS.md': 'ROOT',
      'ws-one:src/AGENTS.md': 'SOURCE DIRECTORY RULES',
      'ws-one:target/AGENTS.md': 'DESTINATION PARENT RULES',
    });
    const mutation =
      name === 'rename_path'
        ? jest.spyOn(h.native, 'renameWorkspacePath')
        : jest.spyOn(h.native, 'removeWorkspacePath');
    const call = {
      name,
      arguments:
        name === 'rename_path' ? { path: 'src', destination: 'target/moved' } : { path: 'src' },
    };
    h.llama.reply({ toolCalls: [call] }, { toolCalls: [call] }, { content: 'Done.' });
    await h.runtime.loop.send(h.thread.id, 'Change the directory.', 'directory-mutation');
    expect(h.prompt(0)).not.toContain('SOURCE DIRECTORY RULES');
    expect(h.prompt(1)).toContain('SOURCE DIRECTORY RULES');
    if (name === 'rename_path') {
      expect(h.prompt(1)).toContain('DESTINATION PARENT RULES');
    }
    expect(mutation).toHaveBeenCalledTimes(1);
    await h.runtime.dispose();
  },
);

test('missing rules are optional, but unreadable rules fail visibly without trying CLAUDE fallback and retry works', async () => {
  const h = await harness({ 'ws-one:CLAUDE.md': 'Fallback instructions.' });
  const original = h.native.readWorkspaceFile;
  const read = jest
    .spyOn(h.native, 'readWorkspaceFile')
    .mockImplementation((id, path, offset, limit) => {
      if (path === 'AGENTS.md') {
        return Promise.reject(
          new OnDeviceNativeError('STORAGE_FAILURE', 'Instructions are unreadable.'),
        );
      }
      return original(id, path, offset, limit);
    });
  await expect(h.runtime.loop.send(h.thread.id, 'Hello', 'unreadable')).rejects.toThrow(
    'unreadable',
  );
  expect(h.runtime.threads.get(h.thread.id)).toMatchObject({
    status: 'failed',
    activeTurnId: null,
    lastError: 'Instructions are unreadable.',
  });
  expect(h.runtime.loop.snapshot().phase).toBe('idle');
  expect(h.generate).not.toHaveBeenCalled();
  expect(read.mock.calls.some(([, path]) => path === 'CLAUDE.md')).toBe(false);
  read.mockRestore();
  const result = await h.runtime.loop.retry(h.thread.id);
  expect(result.status).toBe('complete');
  expect(result.messages.filter((message) => message.role === 'user')).toHaveLength(1);
  expect(h.prompt(0)).toContain('Fallback instructions.');
  await h.runtime.dispose();
});

test('empty AGENTS is present, and switching workspaces never shares rules, scopes or skill catalogs', async () => {
  const h = await harness({
    'ws-one:AGENTS.md': '',
    'ws-one:CLAUDE.md': 'DO NOT FALL BACK',
    [`ws-one:${skillId}/SKILL.md`]: skill(),
    'ws-one:src/AGENTS.md': 'ONLY FIRST WORKSPACE',
    'ws-two:AGENTS.md': 'SECOND WORKSPACE',
  });
  h.llama.reply({ toolCalls: [{ name: 'list_directory', arguments: { path: 'src' } }] });
  await h.runtime.loop.send(h.thread.id, 'Inspect src.', 'first-workspace');
  const second = await h.runtime.threads.create('ws-two', modelId);
  await h.runtime.loop.send(second.id, 'Hello', 'second-workspace');
  expect(h.prompt(0)).not.toContain('DO NOT FALL BACK');
  expect(h.prompt(1)).toContain('ONLY FIRST WORKSPACE');
  expect(h.prompt(2)).toContain('SECOND WORKSPACE');
  expect(h.prompt(2)).not.toMatch(/ONLY FIRST|Review local changes|\.agents\/skills\/review/);
  await h.runtime.dispose();
});

test.each([
  '../outside',
  '/phone/home',
  'a/../outside',
  'a\\.git/config',
  '.GIT/config',
  'a//file',
])('tool paths cannot cause guidance reads outside the workspace: %s', async (path) => {
  const h = await harness();
  h.llama.reply({ toolCalls: [{ name: 'read_file', arguments: { path } }] });
  const result = await h.runtime.loop.send(h.thread.id, 'Read the requested file.', 'unsafe-path');
  expect(result.messages.find((entry) => entry.tool)?.content).toContain('inside the workspace');
  expect(h.calls.some((call) => call.includes(JSON.stringify(path)))).toBe(false);
  await h.runtime.dispose();
});

test('native symlink rejection is not treated as an optional missing rule', async () => {
  const h = await harness();
  jest
    .spyOn(h.native, 'readWorkspaceFile')
    .mockRejectedValue(
      new OnDeviceNativeError('PATH_UNSUPPORTED', 'Symbolic links cannot be followed.'),
    );
  await expect(h.runtime.loop.send(h.thread.id, 'Hello', 'symlink')).rejects.toThrow(
    'Symbolic links',
  );
  expect(h.generate).not.toHaveBeenCalled();
  expect(h.runtime.loop.snapshot().phase).toBe('idle');
  await h.runtime.dispose();
});

test.each([
  [skill('review', '{}'), 'description must be'],
  [skill('review', '42'), 'description must be'],
  [skill('review', 'false'), 'description must be'],
  ['---\nname: review\nname: review\ndescription: fine\n---\nBody', 'invalid YAML'],
  ['---\nname: review\ndescription: &d description\nlicense: *d\n---\nBody', 'aliases'],
  ['---\nname: review\ndescription: fine\nmetadata: [bad]\n---\nBody', 'metadata must'],
  ['---\nname: review\ndescription: fine\nuser-invocable: yes\n---\nBody', 'true or false'],
  ['---\nname: review\ndescription: fine\ncontext: thread\n---\nBody', 'context must'],
  [`---\nname: review\ndescription: ${'x'.repeat(GUIDANCE_FILE_BYTES)}\n---\nBody`, 'frontmatter'],
])(
  'an invalid skill is skipped with a diagnostic while the turn and other skills work (%s)',
  async (definition, error) => {
    const h = await harness({
      [`ws-one:${skillId}/SKILL.md`]: definition,
      'ws-one:.agents/skills/lint/SKILL.md': skill('lint', 'Lint the code.', 'LINT BODY'),
    });
    h.llama.reply(
      { toolCalls: [{ name: 'skill', arguments: { name: 'lint' } }] },
      { content: 'Linted.' },
    );
    const result = await h.runtime.loop.send(h.thread.id, 'Review.', 'invalid-skill');
    expect(result.status).toBe('complete');
    expect(h.prompt(0)).toContain('- lint: Lint the code.');
    expect(h.prompt(0)).not.toContain('- review:');
    expect(result.messages.find((entry) => entry.tool)?.content).toContain('LINT BODY');
    const listing = await h.runtime.skills.list('ws-one');
    expect(listing.skills.map((entry) => entry.name)).toEqual(['lint']);
    expect(listing.diagnostics).toEqual([
      {
        source: 'project',
        location: skillId,
        message: expect.stringContaining(error),
        severity: 'skipped',
      },
    ]);
    await h.runtime.dispose();
  },
);

test('large and many-skill roots stay deterministic and duplicates are shadowed by precedence', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 40; index += 1) {
    const name = `entry-${String(index).padStart(2, '0')}`;
    files[`ws-one:.agents/skills/${name}/SKILL.md`] = skill(name);
  }
  files['ws-one:.agents/skills/review/SKILL.md'] = skill('review', 'Preferred review');
  files['ws-one:.claude/skills/review/SKILL.md'] = skill('review', 'Shadowed review');
  const h = await harness(files);
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { name: 'review' } }] });
  const result = await h.runtime.loop.send(h.thread.id, 'Review.', 'bounded');
  expect(h.prompt(0)).toContain('- entry-39: Review local changes.');
  expect(h.prompt(0)).toContain('- review: Preferred review');
  expect(h.prompt(0)).not.toContain('Shadowed review');
  expect(result.messages.find((entry) => entry.tool)?.content).toContain(
    '"location":".agents/skills/review"',
  );
  const listing = await h.runtime.skills.list('ws-one');
  expect(listing.skills).toHaveLength(41);
  expect(listing.diagnostics).toEqual([
    {
      source: 'project',
      location: '.claude/skills/review',
      message: 'Shadowed by the project skill .agents/skills/review.',
      severity: 'skipped',
    },
  ]);
  await h.runtime.dispose();
});

test('model sees only concise metadata until the real skill tool loads full YAML/Markdown and every bundled file', async () => {
  const definition = skill(
    'review',
    '>\n  Review local changes\n  when requested.',
    'FULL INSTRUCTIONS\nSee references/checklist.md.',
  );
  const h = await harness({
    [`ws-one:${skillId}/SKILL.md`]: definition,
    [`ws-one:${skillId}/references/checklist.md`]: 'Local checklist',
    [`ws-one:${skillId}/assets/example.json`]: '{}',
    [`ws-one:${skillId}/scripts/run.js`]: 'console.log(1)',
    [`ws-one:${skillId}/run.sh`]: 'echo hi',
  });
  h.llama.reply(
    { toolCalls: [{ name: 'skill', arguments: { name: 'review' } }] },
    { content: 'Loaded.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, 'Review changes.', 'load-skill');
  expect(h.prompt(0)).toContain('- review: Review local changes when requested.');
  expect(h.prompt(0)).not.toContain('FULL INSTRUCTIONS');
  expect(h.generate.mock.calls[0]?.[1]).toContainEqual(
    expect.objectContaining({ function: expect.objectContaining({ name: 'skill' }) }),
  );
  const tool = result.messages.find((entry) => entry.tool);
  expect(tool?.tool?.status).toBe('completed');
  const output: unknown = JSON.parse(tool?.content ?? '{}');
  expect(output).toMatchObject({
    name: 'review',
    source: 'project',
    location: skillId,
    content: definition,
    nextOffset: null,
    files: ['run.sh', 'assets/example.json', 'references/checklist.md', 'scripts/run.js'],
    filesTruncated: false,
    note: expect.stringContaining('scripts cannot run'),
  });
  expect(h.generate.mock.calls[1]?.[0].find((entry) => entry.role === 'tool')?.content).toContain(
    'FULL INSTRUCTIONS',
  );
  await h.runtime.dispose();
});

test('an edit refreshes rules in the very next round, and subsequent turns discover fresh skills', async () => {
  const h = await harness({ 'ws-one:AGENTS.md': 'OLD RULE' });
  h.llama.reply(
    { toolCalls: [{ name: 'read_file', arguments: { path: 'AGENTS.md' } }] },
    { toolCalls: [{ name: 'write_file', arguments: { path: 'AGENTS.md', content: 'NEW RULE' } }] },
    { content: 'Edited.' },
  );
  await h.runtime.loop.send(h.thread.id, 'Update the root rules.', 'edit-rules');
  expect(h.prompt(1)).toContain('OLD RULE');
  expect(h.prompt(2)).toContain('NEW RULE');
  expect(h.prompt(2)).not.toContain('OLD RULE');
  h.files.set(`ws-one:${skillId}/SKILL.md`, skill('review', 'Fresh catalog', 'Fresh body'));
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { name: 'review' } }] });
  const next = await h.runtime.loop.send(h.thread.id, 'Review now.', 'fresh-turn');
  expect(h.prompt(3)).toContain('Fresh catalog');
  expect(next.messages.at(-2)?.content).toContain('Fresh body');
  await h.runtime.dispose();
});

test('rules edited during inference fence a pending mutation until a refreshed model round', async () => {
  const h = await harness({ 'ws-one:AGENTS.md': 'BEFORE INFERENCE' });
  const generate = LocalModelSession.prototype.generate.bind(h.runtime.models);
  h.generate.mockImplementationOnce(async (...args) => {
    const reply = await generate(...args);
    h.files.set('ws-one:AGENTS.md', 'AFTER INFERENCE');
    return reply;
  });
  const write = jest.spyOn(h.native, 'writeWorkspaceFile');
  const call = { name: 'write_file', arguments: { path: 'new.txt', content: 'new' } };
  h.llama.reply({ toolCalls: [call] }, { toolCalls: [call] }, { content: 'Done.' });
  const result = await h.runtime.loop.send(h.thread.id, 'Create new.txt', 'inference-race');
  expect(h.prompt(0)).toContain('BEFORE INFERENCE');
  expect(h.prompt(1)).toContain('AFTER INFERENCE');
  expect(write).toHaveBeenCalledTimes(1);
  expect(result.messages.filter((entry) => entry.tool).map((entry) => entry.tool?.status)).toEqual([
    'failed',
    'completed',
  ]);
  await h.runtime.dispose();
});

test('the catalog advertises as many skills as fit the context, says how many were omitted, and rejects oversized rules', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 150; index += 1) {
    const name = `skill-${String(index).padStart(3, '0')}`;
    files[`ws-one:.agents/skills/${name}/SKILL.md`] = skill(name, 'Short.');
  }
  const h = await harness(files);
  h.memory.availableBytes = modelMemoryBytes(localModelDefinition(modelId), 8192);
  await h.runtime.loop.send(h.thread.id, 'Hello', 'catalog-count');
  const advertised = (h.prompt(0).match(/^- skill-\d+: Short\.$/gmu) ?? []).length;
  expect(advertised).toBeGreaterThan(12);
  expect(advertised).toBeLessThan(128);
  expect(h.prompt(0)).toContain(
    `${String(128 - advertised)} more skills omitted for context; call skill without a name to list them.`,
  );
  const listing = await h.runtime.skills.list('ws-one');
  expect(listing.skills).toHaveLength(128);
  expect(listing.diagnostics).toEqual([
    {
      source: 'project',
      location: '.agents/skills',
      message: 'Skipped 22 skills beyond 128 per root.',
      severity: 'skipped',
    },
  ]);
  h.files.set('ws-one:AGENTS.md', 'x'.repeat(GUIDANCE_FILE_BYTES + 1));
  await expect(h.runtime.loop.send(h.thread.id, 'Again', 'too-large')).rejects.toThrow(
    '8192 bytes',
  );
  h.files.set('ws-one:AGENTS.md', 'x'.repeat(8000));
  const snapshot = h.runtime.models.snapshot();
  jest.spyOn(h.runtime.models, 'snapshot').mockReturnValue({ ...snapshot, contextTokens: 4096 });
  await expect(h.runtime.loop.retry(h.thread.id)).rejects.toThrow('context budget');
  await h.runtime.dispose();
});

test('Stop during a pending guidance read settles promptly and late completion cannot generate; retry re-reads', async () => {
  const h = await harness();
  const original = h.native.readWorkspaceFile;
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = jest
    .spyOn(h.native, 'readWorkspaceFile')
    .mockImplementation(async (id, path, offset, limit) => {
      if (path === 'AGENTS.md') {
        entered();
        await pending;
      }
      return original(id, path, offset, limit);
    });
  const running = h.runtime.loop.send(h.thread.id, 'Hello', 'stop-guidance');
  await started;
  await h.runtime.loop.stop();
  const stopped = await running;
  expect(stopped).toMatchObject({ status: 'interrupted', activeTurnId: null });
  expect(h.runtime.loop.snapshot().phase).toBe('idle');
  expect(h.generate).not.toHaveBeenCalled();
  release();
  await pending;
  read.mockRestore();
  h.files.set('ws-one:AGENTS.md', 'AFTER STOP');
  await h.runtime.loop.retry(h.thread.id);
  expect(h.prompt(0)).toContain('AFTER STOP');
  expect(h.generate).toHaveBeenCalledTimes(1);
  await h.runtime.dispose();
});

test.each(['../review', 'a/../../outside', '.git/config', '/phone/home', 'a\\b'])(
  'skill resources cannot leave the skill directory: %s',
  async (resource) => {
    const h = await harness({ [`ws-one:${skillId}/SKILL.md`]: skill() });
    h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { name: 'review', resource } }] });
    const result = await h.runtime.loop.send(h.thread.id, 'Load that file.', 'bad-resource');
    expect(result.messages.find((entry) => entry.tool)).toMatchObject({
      tool: { status: 'failed' },
      content: expect.stringContaining('inside the workspace'),
    });
    const reads = h.calls.filter((call) => call.startsWith('readWorkspaceFile'));
    expect(
      reads.every((call) => /((SKILL|AGENTS|CLAUDE)\.md|opencode\.jsonc?)"\]$/u.test(call)),
    ).toBe(true);
    await h.runtime.dispose();
  },
);

test('symlinked skill directories are skipped with a diagnostic and resource links are never listed or read', async () => {
  const h = await harness({ [`ws-one:${skillId}/SKILL.md`]: skill() });
  const original = h.native.listWorkspaceFiles;
  jest.spyOn(h.native, 'listWorkspaceFiles').mockImplementation((id, path, limit) => {
    if (path === '.agents/skills') {
      return original(id, path, limit).then((listing) => ({
        ...listing,
        entries: [...listing.entries, { name: 'linked', kind: 'symlink', bytes: 0 }],
      }));
    }
    if (path === `${skillId}/references`) {
      return Promise.resolve({
        entries: [
          { name: 'outside.md', kind: 'symlink', bytes: 0 },
          { name: 'safe.md', kind: 'file', bytes: 10 },
        ],
        truncated: false,
      });
    }
    if (path === skillId) {
      return Promise.resolve({
        entries: [
          { name: 'SKILL.md', kind: 'file', bytes: 10 },
          { name: 'references', kind: 'directory', bytes: 0 },
        ],
        truncated: false,
      });
    }
    return original(id, path, limit);
  });
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { name: 'review' } }] });
  const result = await h.runtime.loop.send(h.thread.id, 'Review.', 'linked-catalog');
  expect(result.status).toBe('complete');
  const output: unknown = JSON.parse(result.messages.find((entry) => entry.tool)?.content ?? '');
  expect(output).toMatchObject({
    files: ['references/safe.md'],
    skippedFiles: [
      { path: 'references/outside.md', reason: 'Links and special files are not supported.' },
    ],
  });
  expect(h.calls.some((call) => call.includes('outside.md'))).toBe(false);
  expect((await h.runtime.skills.list('ws-one')).diagnostics).toEqual([
    {
      source: 'project',
      location: '.agents/skills/linked',
      message: 'Skipped: discovery does not follow links.',
      severity: 'skipped',
    },
  ]);
  await h.runtime.dispose();
});

test('a skill changed after advertisement loads fresh contents, and an unreadable definition is a tool error, not a failed turn', async () => {
  const h = await harness({ [`ws-one:${skillId}/SKILL.md`]: skill() });
  const generate = LocalModelSession.prototype.generate.bind(h.runtime.models);
  h.generate.mockImplementationOnce(async (...args) => {
    const result = await generate(...args);
    h.files.set(
      `ws-one:${skillId}/SKILL.md`,
      skill('review', 'Edited metadata', 'FRESH ON DEMAND'),
    );
    return result;
  });
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { name: 'review' } }] });
  const result = await h.runtime.loop.send(h.thread.id, 'Review.', 'fresh-demand');
  expect(h.prompt(0)).toContain('Review local changes.');
  expect(result.messages.find((entry) => entry.tool)?.content).toContain('FRESH ON DEMAND');
  expect(h.prompt(1)).toContain('Edited metadata');
  const read = h.native.readWorkspaceFile;
  h.generate.mockImplementationOnce(async (...args) => {
    const response = await generate(...args);
    jest
      .spyOn(h.native, 'readWorkspaceFile')
      .mockImplementation((id, path, offset, limit) =>
        path === `${skillId}/SKILL.md`
          ? Promise.reject(new OnDeviceNativeError('STORAGE_FAILURE', 'Skill became unreadable.'))
          : read(id, path, offset, limit),
      );
    return response;
  });
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { name: 'review' } }] });
  const settled = await h.runtime.loop.send(h.thread.id, 'Review again.', 'unreadable-demand');
  expect(settled.status).toBe('complete');
  const tool = h.runtime.threads
    .get(h.thread.id)
    .messages.filter((entry) => entry.tool)
    .at(-1);
  expect(tool).toMatchObject({
    tool: { status: 'failed' },
    content: expect.stringContaining('Skill became unreadable'),
  });
  await h.runtime.dispose();
});

test('Stop during on-demand skill loading preserves interruption and generates no follow-up round', async () => {
  const h = await harness({ [`ws-one:${skillId}/SKILL.md`]: skill() });
  const read = h.native.readWorkspaceFile;
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  jest.spyOn(h.native, 'readWorkspaceFile').mockImplementation(async (id, path, offset, limit) => {
    if (path === `${skillId}/SKILL.md` && ++reads === 2) {
      entered();
      await pending;
    }
    return read(id, path, offset, limit);
  });
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { name: 'review' } }] });
  const running = h.runtime.loop.send(h.thread.id, 'Review.', 'stop-skill');
  await started;
  const stopping = h.runtime.loop.stop();
  expect(h.runtime.loop.snapshot().phase).toBe('stopping');
  release();
  await stopping;
  const result = await running;
  expect(result).toMatchObject({ status: 'interrupted', activeTurnId: null });
  expect(result.messages.find((entry) => entry.tool)?.tool?.status).toBe('interrupted');
  expect(h.generate).toHaveBeenCalledTimes(1);
  expect(h.runtime.loop.snapshot().phase).toBe('idle');
  await h.runtime.dispose();
});
