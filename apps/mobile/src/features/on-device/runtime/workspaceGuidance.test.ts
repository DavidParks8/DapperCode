import { randomUUID } from 'expo-crypto';
import { loadNativeModelContext } from '../models/engine';
import { LocalModelSession } from '../models/session';
import { OnDeviceNativeError } from '../native/services.errors';
import { OnDeviceRuntime } from './runtime';
import { createFakeOnDeviceNative, FakeLlama } from './testing';
import { GUIDANCE_FILE_BYTES, SKILL_DIRECTORY_LIMIT } from './workspaceGuidance';

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
  ['no YAML', 'frontmatter'],
  [skill('Other'), 'name must match'],
  [skill('review', '{}'), 'description must be'],
  [skill('review', '42'), 'description must be'],
  [skill('review', 'false'), 'description must be'],
  ['---\nname: review\nname: review\ndescription: fine\n---\nBody', 'invalid YAML'],
  ['---\nname: review\ndescription: &d description\nlicense: *d\n---\nBody', 'aliases'],
  ['---\nname: review\ndescription: fine\nmetadata: [bad]\n---\nBody', 'metadata must'],
  [skill('review', 'fine', 'x'.repeat(GUIDANCE_FILE_BYTES)), '8192 bytes'],
])(
  'invalid skill definitions fail explicitly before model generation (%s)',
  async (definition, error) => {
    const h = await harness({ [`ws-one:${skillId}/SKILL.md`]: definition });
    await expect(h.runtime.loop.send(h.thread.id, 'Review.', 'invalid-skill')).rejects.toThrow(
      error,
    );
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.runtime.threads.get(h.thread.id).status).toBe('failed');
    await h.runtime.dispose();
  },
);

test('catalog is bounded, deterministic and explicit about omitted skill roots and duplicates', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < SKILL_DIRECTORY_LIMIT + 1; index += 1) {
    const name = `entry-${String(index)}`;
    files[`ws-one:.agents/skills/${name}/SKILL.md`] = skill(name);
  }
  files['ws-one:.opencode/skills/review/SKILL.md'] = skill('review', 'Preferred review');
  files['ws-one:.claude/skills/review/SKILL.md'] = skill('review', 'Shadowed review');
  const h = await harness(files);
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { id: '.claude/skills/review' } }] });
  const result = await h.runtime.loop.send(h.thread.id, 'Review.', 'bounded');
  expect(h.prompt(0)).toContain('.agents/skills: omitted; more than 16 entries');
  expect(h.prompt(0)).toContain('Duplicate skill review');
  expect(h.prompt(0)).toContain('Preferred review');
  expect(h.prompt(0)).not.toContain('Shadowed review');
  expect(result.messages.find((entry) => entry.tool)?.content).toContain('shadowed');
  await h.runtime.dispose();
});

test('model sees only concise metadata until the real skill tool loads full YAML/Markdown and safe references', async () => {
  const definition = skill(
    'review',
    '>\n  Review local changes\n  when requested.',
    'FULL INSTRUCTIONS\nSee references/checklist.md.',
  );
  const h = await harness({
    [`ws-one:${skillId}/SKILL.md`]: definition,
    [`ws-one:${skillId}/references/checklist.md`]: 'Local checklist',
    [`ws-one:${skillId}/assets/example.json`]: '{}',
    [`ws-one:${skillId}/scripts/run.js`]: 'Do not execute',
    [`ws-one:${skillId}/run.sh`]: 'Do not execute',
  });
  h.llama.reply(
    { toolCalls: [{ name: 'skill', arguments: { id: skillId } }] },
    { content: 'Loaded.' },
  );
  const result = await h.runtime.loop.send(h.thread.id, 'Review changes.', 'load-skill');
  expect(h.prompt(0)).toContain('Review local changes when requested.');
  expect(h.prompt(0)).not.toContain('FULL INSTRUCTIONS');
  expect(h.generate.mock.calls[0]?.[1]).toContainEqual(
    expect.objectContaining({ function: expect.objectContaining({ name: 'skill' }) }),
  );
  const tool = result.messages.find((entry) => entry.tool);
  expect(tool?.tool?.status).toBe('completed');
  const output: unknown = JSON.parse(tool?.content ?? '{}');
  expect(output).toMatchObject({
    definition,
    resources: [`${skillId}/assets/example.json`, `${skillId}/references/checklist.md`],
    resourcesTruncated: false,
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
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { id: skillId } }] });
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

test('catalog caps advertised IDs and rejects rule files exceeding file or context bounds, without truncating instructions', async () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 15; index += 1) {
    const name = `skill-${String(index)}`;
    files[`ws-one:.agents/skills/${name}/SKILL.md`] = skill(name, 'Short.');
  }
  const h = await harness(files);
  await h.runtime.loop.send(h.thread.id, 'Hello', 'catalog-count');
  const advertised = (h.prompt(0).match(/"\.agents\/skills\/skill-/gu) ?? []).length;
  expect(advertised).toBeLessThanOrEqual(12);
  expect(advertised).toBeGreaterThan(0);
  expect(h.prompt(0)).toMatch(/Advertised \d+ of 15/);
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

test.each([
  '../review',
  '.agents/skills/../review',
  '.git/skills/review',
  'https://example.com/skill',
])(
  'the skill tool rejects non-workspace and traversal IDs without fetching them: %s',
  async (id) => {
    const h = await harness();
    h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { id } }] });
    const result = await h.runtime.loop.send(h.thread.id, 'Load that skill.', 'bad-skill-id');
    expect(result.messages.find((entry) => entry.tool)?.tool?.status).toBe('failed');
    expect(h.calls.some((call) => call.includes(JSON.stringify(id)))).toBe(false);
    await h.runtime.dispose();
  },
);

test('symlink skill directories fail explicitly and resource symlinks are never advertised or read', async () => {
  const h = await harness({ [`ws-one:${skillId}/SKILL.md`]: skill() });
  const original = h.native.listWorkspaceFiles;
  const list = jest.spyOn(h.native, 'listWorkspaceFiles').mockImplementation((id, path, limit) => {
    if (path === '.agents/skills') {
      return Promise.resolve({
        entries: [{ name: 'linked', kind: 'symlink', bytes: 0 }],
        truncated: false,
      });
    }
    return original(id, path, limit);
  });
  await expect(h.runtime.loop.send(h.thread.id, 'Review.', 'linked-catalog')).rejects.toThrow(
    'does not follow links',
  );
  list.mockImplementation((id, path, limit) => {
    if (path === `${skillId}/references`) {
      return Promise.resolve({
        entries: [
          { name: 'outside.md', kind: 'symlink', bytes: 0 },
          { name: 'safe.md', kind: 'file', bytes: 10 },
        ],
        truncated: false,
      });
    }
    return original(id, path, limit);
  });
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { id: skillId } }] });
  const result = await h.runtime.loop.retry(h.thread.id);
  const output = result.messages.find((entry) => entry.tool)?.content ?? '';
  expect(output).toContain('safe.md');
  expect(output).not.toContain('outside.md');
  expect(h.calls.some((call) => call.includes('outside.md'))).toBe(false);
  await h.runtime.dispose();
});

test('a skill changed after advertisement loads fresh contents, and unreadable on-demand definitions stay tool errors', async () => {
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
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { id: skillId } }] });
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
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { id: skillId } }] });
  await expect(
    h.runtime.loop.send(h.thread.id, 'Review again.', 'unreadable-demand'),
  ).rejects.toThrow('Skill became unreadable');
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
  h.llama.reply({ toolCalls: [{ name: 'skill', arguments: { id: skillId } }] });
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
