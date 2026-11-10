import { randomUUID } from 'expo-crypto';
import { localModelDefinition } from '../models/catalog';
import type { LocalContextLoader, LocalModelMessage, LocalModelReply } from '../models/engine';
import { modelMemoryBytes } from '../models/memory';
import { LocalModelSession } from '../models/session';
import { LocalAgentLoop, type LocalRunSnapshot } from './agentLoop';
import { LOCAL_TOOL_DEFINITIONS, localToolApproval, localToolExecutor } from './localTools';
import { localAgentSystemPrompt } from './systemPrompt';
import { LocalThreadRepository } from './threads';
import { createFakeOnDeviceNative, FakeLlama } from './testing';
import { advertisedLocalTools, toolDefinitionName } from './toolDefinition';
import type { LocalMessage } from './types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../models/engine', () => ({ loadNativeModelContext: jest.fn() }));

beforeEach(() => {
  let sequence = 0;
  jest
    .mocked(randomUUID)
    .mockImplementation(() => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`);
});

const SUMMARY = 'Maintain a concise rolling memory';
const TOOLS = '\n# Tools\n';
const modelId = 'qwen3-0.6b-q4-0';
const note = (turn: number) => `NOTE-${String(turn)} `.repeat(300);
const memory: LocalModelReply = {
  content: 'Memory of earlier turns.',
  reasoning_content: '',
  tool_calls: [],
  interrupted: false,
  truncated: false,
  stopped_limit: 0,
  tokens_predicted: 1,
  tokens_evaluated: 1,
};

/**
 * Like a native chat template, every formatted prompt renders the advertised tool schemas, so they
 * count as tokens. Summary rounds answer from `summaryReplies` (default: a short memory) and never
 * consume the scripted turn replies.
 */
function toolTemplate(llama: FakeLlama) {
  const prompts: string[] = [];
  const summaryReplies: Partial<LocalModelReply>[] = [];
  const loader: LocalContextLoader = async (...args) => {
    const context = await llama.loader(...args);
    return {
      ...context,
      getFormattedChat: async (messages, template, options) => {
        const formatted = await context.getFormattedChat(messages, template, options);
        const tools =
          Array.isArray(options?.tools) && options.tools.length
            ? TOOLS + JSON.stringify(options.tools)
            : '';
        return { ...formatted, prompt: formatted.prompt + tools };
      },
      completion: async (params, callback) => {
        prompts.push(params.prompt ?? '');
        return params.prompt?.includes(SUMMARY)
          ? { ...memory, ...summaryReplies.shift() }
          : context.completion(params, callback);
      },
    };
  };
  return { loader, prompts, summaryReplies };
}

/**
 * The real loop, session, repository and file tools on fake native services. The tokenizer
 * approximates the measured Qwen3 density for schemas and prose, so the fixed prefix is counted like
 * on device.
 */
async function harness(contextTokens: 4096 | 8192) {
  const llama = new FakeLlama();
  llama.charactersPerToken = 3.5;
  const template = toolTemplate(llama);
  const model = localModelDefinition(modelId);
  const files = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `ws-one:notes-${String(index + 1)}.txt`,
      note(index + 1),
    ]),
  );
  const fake = createFakeOnDeviceNative(llama, {
    downloaded: [modelId],
    files,
    availableBytes: modelMemoryBytes(model, contextTokens),
  });
  const session = new LocalModelSession(fake.native, template.loader, jest.fn());
  const threads = new LocalThreadRepository(fake.native, jest.fn(), 0);
  await threads.initialize();
  const thread = await threads.create('ws-one', modelId);
  const events: LocalRunSnapshot[] = [];
  const loop = new LocalAgentLoop(
    threads,
    session,
    LOCAL_TOOL_DEFINITIONS,
    localToolExecutor(
      fake.native,
      () => ({ name: 'Test', email: 'test@example.com' }),
      async () => null,
      () => undefined,
    ),
    (event) => events.push(event),
    localToolApproval,
  );
  const { prompts, summaryReplies } = template;
  const answers = () => prompts.filter((prompt) => !prompt.includes(SUMMARY));
  const summaries = () => prompts.filter((prompt) => prompt.includes(SUMMARY));
  /** One turn that reads a note and answers from it. */
  const readTurn = async (turn: number) => {
    llama.reply(
      { toolCalls: [{ name: 'read_file', arguments: { path: `notes-${String(turn)}.txt` } }] },
      { content: `Note ${String(turn)} has been read.` },
    );
    const result = await loop.send(thread.id, request(turn), `turn-${String(turn)}`);
    expect(result).toMatchObject({ status: 'complete', lastError: null });
    return result;
  };
  return {
    llama,
    prompts,
    summaryReplies,
    fake,
    session,
    threads,
    thread,
    loop,
    events,
    answers,
    summaries,
    readTurn,
    close: async () => {
      await threads.flush();
      threads.close();
      await session.dispose();
    },
  };
}

const request = (turn: number) => `Request ${String(turn)}: read notes-${String(turn)}.txt.`;
const toolNames = (prompt: string) =>
  (JSON.parse(prompt.split(TOOLS)[1] ?? '[]') as object[]).map(toolDefinitionName);
const promptMessages = (prompt: string) =>
  JSON.parse(prompt.split(TOOLS)[0] ?? '[]') as LocalModelMessage[];
const lastUser = (prompt: string) =>
  promptMessages(prompt)
    .filter((message: LocalModelMessage) => message.role === 'user')
    .at(-1)?.content ?? '';

test('8K context: a read result stays verbatim for the next edit round and small history is never summarized', async () => {
  const h = await harness(8192);
  await h.readTurn(1);
  h.llama.reply(
    { toolCalls: [{ name: 'read_file', arguments: { path: 'notes-2.txt' } }] },
    {
      toolCalls: [
        {
          name: 'edit_file',
          arguments: { path: 'notes-2.txt', old_text: 'NOTE-2', new_text: 'EDITED-2' },
        },
      ],
    },
    { content: 'Edited.' },
  );
  const done = await h.loop.send(h.thread.id, 'Edit notes-2.txt.', 'edit');
  expect(h.session.snapshot().contextTokens).toBe(8192);
  expect(done).toMatchObject({ status: 'complete', lastError: null });
  expect(h.summaries()).toHaveLength(0);
  expect(done.contextSummary).toBeUndefined();
  const [readRound, editRound, answerRound] = h.answers().slice(-3);
  expect(toolNames(readRound!)).toEqual(
    advertisedLocalTools(LOCAL_TOOL_DEFINITIONS, 8192).map(toolDefinitionName),
  );
  // The edit round sees the complete read result it requested, not a summary or elision marker.
  expect(editRound).toContain(note(2));
  expect(answerRound).toContain('rev-edited');
  const edit = done.messages.find(
    (message: LocalMessage) => message.role === 'tool' && message.tool?.name === 'edit_file',
  );
  expect(JSON.parse(edit!.content)).toMatchObject({ path: 'notes-2.txt', revision: 'rev-edited' });
  await h.close();
});

test('even all 30 tool schemas at 8K keep a requested read verbatim with no summary while earlier history is small', async () => {
  const llama = new FakeLlama();
  llama.charactersPerToken = 3.5;
  const template = toolTemplate(llama);
  const fake = createFakeOnDeviceNative(llama, {
    downloaded: [modelId],
    availableBytes: modelMemoryBytes(localModelDefinition(modelId), 8192),
  });
  const session = new LocalModelSession(fake.native, template.loader, jest.fn());
  await session.load(modelId);
  expect(session.snapshot().contextTokens).toBe(8192);
  const read = (turn: number): LocalModelMessage[] => [
    { role: 'user', content: request(turn) },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          type: 'function',
          id: `call-${String(turn)}`,
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: `notes-${String(turn)}.txt` }),
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: `call-${String(turn)}`,
      content: JSON.stringify({ path: `notes-${String(turn)}.txt`, content: note(turn) }),
    },
  ];
  const checkpoint = {
    key: 'answer-1',
    previous: null,
    started: jest.fn(),
    failed: jest.fn(),
    commit: jest.fn(async () => [] as LocalModelMessage[]),
  };
  await session.generate(
    [
      { role: 'system', content: localAgentSystemPrompt(modelId, new Date(2026, 10, 8)) },
      ...read(1),
      { role: 'assistant', content: 'Note 1 has been read.' },
      ...read(2),
    ],
    LOCAL_TOOL_DEFINITIONS,
    jest.fn(),
    { checkpoint },
  );
  expect(checkpoint.started).not.toHaveBeenCalled();
  expect(template.prompts).toHaveLength(1);
  expect(toolNames(template.prompts[0]!)).toHaveLength(30);
  expect(template.prompts[0]).toContain(note(1));
  expect(template.prompts[0]).toContain(note(2));
  await session.dispose();
});

test('4K context: the measured core tool set leaves room for a normal tool turn', async () => {
  const h = await harness(4096);
  const done = await h.readTurn(1);
  expect(h.session.snapshot().contextTokens).toBe(4096);
  const [readRound, answerRound] = h.answers();
  expect(toolNames(readRound!)).toEqual(
    advertisedLocalTools(LOCAL_TOOL_DEFINITIONS, 4096).map(toolDefinitionName),
  );
  expect(toolNames(readRound!)).not.toContain('web_search');
  expect(promptMessages(readRound!)[0]?.content).not.toContain('web_search');
  expect(answerRound).toContain(note(1));
  expect(done.messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: 'Note 1 has been read.',
  });
  expect(h.summaries()).toHaveLength(0);
  await h.close();
});

test('a long conversation compacts only earlier turns; each current turn stays verbatim and later turns continue', async () => {
  const h = await harness(8192);
  for (let turn = 1; turn <= 6; turn += 1) {
    const before = h.prompts.length;
    const thread = await h.readTurn(turn);
    const prompts = h.prompts.slice(before);
    const summaries = prompts.filter((prompt) => prompt.includes(SUMMARY));
    const answers = prompts.filter((prompt) => !prompt.includes(SUMMARY));
    expect(answers.map(lastUser)).toEqual([
      expect.stringContaining(request(turn)),
      expect.stringContaining(request(turn)),
    ]);
    // The round after the read always sees the complete result it requested.
    expect(answers[1]).toContain(note(turn));
    for (const summary of summaries) {
      expect(summary).not.toContain(request(turn));
    }
    if (summaries.length) {
      expect(summaries.join('')).toContain(request(turn - 1));
      const userIndex = thread.messages.findIndex((message) => message.content === request(turn));
      expect(thread.contextSummary?.throughMessageId).toBe(thread.messages[userIndex - 1]?.id);
      expect(promptMessages(answers[0]!)[0]?.content).toContain('Rolling conversation memory');
    }
  }
  const compactedTurns = h.summaries().length;
  expect(compactedTurns).toBeGreaterThanOrEqual(2);
  // Turn 1 has no earlier history, so the first summary never happens before turn 3.
  expect(h.summaries()[0]).toContain(request(2));
  // Later summaries merge the previous memory instead of re-reading summarized turns.
  expect(h.summaries().at(-1)).toContain('Memory of earlier turns.');
  expect(h.summaries().at(-1)).not.toContain(request(1));
  await h.close();
});

test('a summary that stops at its cap falls back to elision, keeps the previous checkpoint, and later turns continue', async () => {
  const h = await harness(8192);
  let turn = 1;
  while (!h.threads.get(h.thread.id).contextSummary) {
    await h.readTurn(turn++);
  }
  const previous = h.threads.get(h.thread.id).contextSummary;
  // Grow history until the next compaction would run, and make that summary hit its cap.
  h.summaryReplies.push({ content: 'Partial memory', stopped_limit: 1 });
  const failedAt = h.prompts.length;
  while (h.summaryReplies.length) {
    h.events.length = 0;
    const thread = await h.readTurn(turn++);
    expect(thread.contextSummary).toEqual(previous);
  }
  const fallback = h.prompts.slice(failedAt);
  const failedTurn = turn - 1;
  const failedPrompts = fallback.slice(fallback.findIndex((prompt) => prompt.includes(SUMMARY)));
  // Only one summary attempt per earlier history; every later round of the turn uses elision.
  expect(failedPrompts.filter((prompt) => prompt.includes(SUMMARY))).toHaveLength(1);
  const [answer, afterRead] = failedPrompts.filter((prompt) => !prompt.includes(SUMMARY));
  expect(lastUser(answer!)).toContain(request(failedTurn));
  expect(afterRead).toContain(note(failedTurn));
  expect(h.events.map((event) => event.phase)).toEqual(
    expect.arrayContaining(['compacting', 'generating']),
  );
  expect(h.events.map((event) => event.phase).lastIndexOf('generating')).toBeGreaterThan(
    h.events.map((event) => event.phase).indexOf('compacting'),
  );
  expect(h.threads.get(h.thread.id)).toMatchObject({ status: 'complete', lastError: null });
  // A later turn summarizes again and commits newer memory.
  while (
    h.threads.get(h.thread.id).contextSummary?.throughMessageId === previous?.throughMessageId
  ) {
    await h.readTurn(turn++);
    expect(turn).toBeLessThan(12);
  }
  expect(h.threads.get(h.thread.id).contextSummary?.throughMessageId).not.toBe(
    previous?.throughMessageId,
  );
  await h.close();
});
