import { LOCAL_MODEL_CATALOG, LOCAL_MODEL_FAMILIES } from '../models/catalog';
import {
  LOCAL_FAMILY_RESEARCH_GUIDANCE,
  LOCAL_RESEARCH_GUIDANCE,
  localAgentSystemPrompt,
  localResearchGuidance,
} from './systemPrompt';

const today = new Date(2026, 10, 8, 14, 11);
const identity = 'You are a coding agent running locally on an iPhone. ';
const date = " Today's date: Sun Nov 08 2026.";

test('every catalog family has measured research guidance', () => {
  expect(Object.keys(LOCAL_FAMILY_RESEARCH_GUIDANCE).sort()).toEqual(
    LOCAL_MODEL_FAMILIES.map((family) => family.id).sort(),
  );
});

test.each([
  ['qwen35-2b-q4-k-m', 'reminder'],
  ['gemma-4-e2b-q4-0', 'reminder'],
  ['qwen3-1.7b-q4-k-m', 'direct'],
  ['bonsai-2-2b-q2-0', 'direct'],
  ['retired-model', 'reminder'],
] as const)('%s gets the %s research guidance', (modelId, guidance) => {
  expect(localResearchGuidance(modelId)).toBe(guidance);
  const prompt = localAgentSystemPrompt(modelId, today);
  expect(prompt).toContain(LOCAL_RESEARCH_GUIDANCE[guidance].text);
  for (const [name, other] of Object.entries(LOCAL_RESEARCH_GUIDANCE)) {
    if (name !== guidance) {
      expect(prompt).not.toContain(other.text);
    }
  }
});

test('reminder guidance follows the identity, and direct guidance is the last instruction', () => {
  expect(
    localAgentSystemPrompt('qwen35-2b-q4-k-m', today).startsWith(
      `${identity}${LOCAL_RESEARCH_GUIDANCE.reminder.text} Use the listed`,
    ),
  ).toBe(true);
  expect(
    localAgentSystemPrompt('qwen3-1.7b-q4-k-m', today).endsWith(
      `tool evidence. ${LOCAL_RESEARCH_GUIDANCE.direct.text}${date}`,
    ),
  ).toBe(true);
});

test('each guidance tells the model to check with web_search before denying something exists', () => {
  for (const { text } of Object.values(LOCAL_RESEARCH_GUIDANCE)) {
    expect(text).toMatch(/web_search/);
    expect(text).toMatch(/saying (something|they) do(es)? not exist/);
  }
});

test('every catalog model gets its family guidance, the shared rules, and the date last', () => {
  for (const model of LOCAL_MODEL_CATALOG) {
    const prompt = localAgentSystemPrompt(model.id, today);
    expect(prompt.startsWith(identity)).toBe(true);
    expect(prompt).toContain(LOCAL_RESEARCH_GUIDANCE[localResearchGuidance(model.id)].text);
    expect(prompt).toContain('Do not send secrets or workspace content in queries or URLs.');
    expect(prompt).toContain('Do not guess file contents or report success without tool evidence.');
    expect(prompt.endsWith(date)).toBe(true);
  }
});

test('the prompt prefix stays identical across days', () => {
  for (const modelId of ['qwen35-2b-q4-k-m', 'qwen3-1.7b-q4-k-m']) {
    const first = localAgentSystemPrompt(modelId, today);
    const next = localAgentSystemPrompt(modelId, new Date(2026, 10, 9));
    expect(next).not.toBe(first);
    expect(next.startsWith(first.slice(0, -date.length))).toBe(true);
  }
});

test('child roles, instructions, task data and rolling memory preserve measured research placement', () => {
  const context = 'Scoped instructions.\nPersistent tasks.\nRolling conversation memory.';
  const direct = localAgentSystemPrompt('bonsai-2-2b-q2-0', today, 'explore', context);
  expect(direct).toContain('Read-only: never mutate files or Git.');
  expect(direct).toContain(context);
  expect(direct.endsWith(` ${LOCAL_RESEARCH_GUIDANCE.direct.text}${date}`)).toBe(true);
  expect(direct.split(LOCAL_RESEARCH_GUIDANCE.direct.text)).toHaveLength(2);
  const reminder = localAgentSystemPrompt('qwen35-2b-q4-k-m', today, 'general', context);
  expect(
    reminder.startsWith(`${identity}${LOCAL_RESEARCH_GUIDANCE.reminder.text} Use the listed`),
  ).toBe(true);
  expect(reminder.endsWith(date)).toBe(true);
});

test('without advertised web tools, the prompt omits web rules and research guidance but keeps the shared rules', () => {
  for (const model of LOCAL_MODEL_CATALOG) {
    const prompt = localAgentSystemPrompt(model.id, today, undefined, '', false);
    expect(prompt).not.toContain('web_search');
    expect(prompt).not.toContain('web_fetch');
    expect(prompt.startsWith(`${identity}Use the listed`)).toBe(true);
    expect(prompt).toContain('Never emulate unavailable commands');
    expect(
      prompt.endsWith(`Do not guess file contents or report success without tool evidence.${date}`),
    ).toBe(true);
  }
});
