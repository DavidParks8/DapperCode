import {
  elideToolResult,
  generationTokenBudget,
  OMITTED_TURNS_NOTE,
  promptCandidates,
  promptFits,
} from './contextWindow';
import type { LocalModelMessage } from './engine';

const revision = 'b'.repeat(64);
const bulky = JSON.stringify({ path: 'src/a.ts', revision, content: 'z'.repeat(2000) });

function turn(index: number, result = bulky): LocalModelMessage[] {
  return [
    { role: 'user', content: `question ${index}` },
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'thinking '.repeat(50),
      tool_calls: [
        {
          type: 'function',
          id: `call-${index}`,
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'src/a.ts', content: 'y'.repeat(1000) }),
          },
        },
      ],
    },
    { role: 'tool', name: 'write_file', tool_call_id: `call-${index}`, content: result },
    { role: 'assistant', content: `answer ${index}` },
  ];
}

const system: LocalModelMessage = { role: 'system', content: 'system' };

test('elided tool output keeps identifying fields so the model can re-read or continue edits', () => {
  expect(JSON.parse(elideToolResult(bulky))).toEqual({ elided: true, path: 'src/a.ts', revision });
  expect(elideToolResult('{"path":"short"}')).toBe('{"path":"short"}');
  expect(JSON.parse(elideToolResult('x'.repeat(500)))).toEqual({ elided: true });
});

test('candidates shrink history first and never drop the current user message', () => {
  const current: LocalModelMessage[] = [
    { role: 'user', content: 'current question' },
    ...turn(9).slice(1, 3),
  ];
  const messages = [system, ...turn(0), ...turn(1), ...turn(2), ...current];
  const candidates = promptCandidates(messages);
  expect(candidates[0]).toEqual({ messages, scope: 'original' });
  expect(candidates.map((candidate) => candidate.scope)).toEqual([
    'original',
    'history',
    'history',
    'history',
    'history',
    'current',
    'current',
  ]);
  for (const candidate of candidates) {
    expect(candidate.messages).toContainEqual(current[0]);
    expect(candidate.messages[0]?.role).toBe('system');
  }
  const elidedHistory = candidates[1]!.messages;
  expect(elidedHistory).toHaveLength(messages.length);
  expect(JSON.stringify(elidedHistory.slice(1, 13))).not.toContain('z'.repeat(2000));
  expect(JSON.stringify(elidedHistory.slice(1, 13))).not.toContain('thinking');
  // The current turn is untouched until every earlier turn is gone.
  expect(elidedHistory.slice(-3)).toEqual(current);
  const allDropped = candidates[4]!.messages;
  expect(allDropped[0]?.content).toContain(OMITTED_TURNS_NOTE);
  expect(allDropped.slice(1)).toEqual(current);
  const lastResort = candidates[6]!.messages;
  expect(lastResort[1]).toEqual(current[0]);
  expect(JSON.stringify(lastResort)).not.toContain('z'.repeat(2000));
  expect(JSON.stringify(lastResort)).not.toContain('y'.repeat(1000));
  expect(lastResort).toHaveLength(current.length + 1);
});

test('a lone question has no compaction candidates beyond the original prompt', () => {
  const messages: LocalModelMessage[] = [system, { role: 'user', content: 'hi' }];
  expect(promptCandidates(messages)).toEqual([{ messages, scope: 'original' }]);
});

test('token budgets reserve generation room and give generation everything else', () => {
  expect(promptFits(4096 - 1024 - 32, 4096)).toBe(true);
  expect(promptFits(4096 - 1024 - 31, 4096)).toBe(false);
  expect(promptFits(16_384 - 2 * 2048 - 32, 16_384, 2)).toBe(true);
  expect(generationTokenBudget(1000, 4096)).toBe(3064);
});
