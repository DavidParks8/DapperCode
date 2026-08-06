import type { ChatMessage } from '@bridge/types/types';
import { formatMessageTimestamp, resolveMessageTimestamp } from './messageTimestamp';

const CREATED_AT = '2026-07-20T19:42:00.000Z';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message',
    role: 'assistant',
    content: 'Done',
    createdAt: CREATED_AT,
    ...overrides,
  } as ChatMessage;
}

describe('message timestamp reveal', () => {
  it('uses send time for user messages and completion time for assistant responses', () => {
    expect(resolveMessageTimestamp(message({ role: 'user' }))).toBe(CREATED_AT);
    expect(
      resolveMessageTimestamp(
        message({
          completedAt: '2026-07-20T19:43:12.000Z',
        }),
      ),
    ).toBe('2026-07-20T19:43:12.000Z');
  });

  it('excludes unfinished responses, tool calls, and non-conversation roles', () => {
    expect(resolveMessageTimestamp(message({ pending: true }))).toBeNull();
    expect(
      resolveMessageTimestamp(
        message({
          toolCalls: [
            { id: 'tool', type: 'function', function: { name: 'read', arguments: '{}' } },
          ],
        }),
      ),
    ).toBeNull();
    expect(resolveMessageTimestamp(message({ role: 'developer' }))).toBeNull();
    expect(resolveMessageTimestamp(message({ role: 'system' }))).toBeNull();
    expect(resolveMessageTimestamp(message({ role: 'reasoning' }))).toBeNull();
    expect(
      resolveMessageTimestamp(message({ role: 'activity', content: { text: 'Working' } })),
    ).toBeNull();
    expect(
      resolveMessageTimestamp(
        message({ role: 'tool', toolCallId: 'tool', content: 'Tool result' }),
      ),
    ).toBeNull();
  });

  it('rejects invalid timestamps and formats valid ones as a device-local short time', () => {
    expect(resolveMessageTimestamp(message({ createdAt: 'not-a-date' }))).toBeNull();
    expect(formatMessageTimestamp(CREATED_AT)).toBe(
      new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(
        new Date(CREATED_AT),
      ),
    );
  });
});
