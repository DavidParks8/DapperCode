import type { Chat } from '@bridge/types/types';
import {
  formatActivityElapsedAccessibilityLabel,
  formatActivityElapsedTime,
  resolveActivityElapsedMs,
} from './activityDuration';

const chat: Chat = {
  id: 'thread',
  title: 'Timer',
  status: 'running',
  createdAt: '2026-08-05T12:00:00.000Z',
  updatedAt: '2026-08-05T12:00:00.000Z',
  statusUpdatedAt: '2026-08-05T12:00:00.000Z',
  lastMessagePreview: 'work',
  messages: [{ id: 'user', role: 'user', content: 'work', createdAt: '2026-08-05T12:00:00.000Z' }],
};

describe('activity duration', () => {
  it('measures a running turn from an authoritative start timestamp', () => {
    expect(
      resolveActivityElapsedMs(
        { ...chat, lastRunStartedAt: '2026-08-05T12:00:00.000Z' },
        { tone: 'running', title: 'Editing file' },
        Date.parse('2026-08-05T12:01:05.900Z'),
      ),
    ).toBe(65_900);
  });

  it('uses the locally observed start instead of stale transcript timestamps', () => {
    expect(
      resolveActivityElapsedMs(
        {
          ...chat,
          statusUpdatedAt: '2024-01-01T00:00:00.000Z',
          messages: [
            {
              id: 'stale-user',
              role: 'user',
              content: 'old work',
              createdAt: '2024-01-01T00:00:00.000Z',
            },
          ],
        },
        { tone: 'running', title: 'Working' },
        Date.parse('2026-08-05T12:00:05.000Z'),
        { startedAtMs: Date.parse('2026-08-05T12:00:00.000Z'), elapsedMs: null },
      ),
    ).toBe(5_000);
  });

  it('prefers authoritative run timing and freezes terminal turns', () => {
    const settled: Chat = {
      ...chat,
      status: 'complete',
      statusUpdatedAt: '2026-08-05T12:02:00.000Z',
      lastRunStartedAt: '2026-08-05T12:00:10.000Z',
      lastRunFinishedAt: '2026-08-05T12:01:20.000Z',
      messages: [
        ...chat.messages,
        {
          id: 'queued-user',
          role: 'user',
          content: 'follow up',
          createdAt: '2026-08-05T12:01:00.000Z',
        },
      ],
    };
    expect(
      resolveActivityElapsedMs(
        settled,
        { tone: 'complete', title: 'Turn completed' },
        Date.parse('2026-08-05T13:00:00.000Z'),
      ),
    ).toBe(70_000);
    expect(
      resolveActivityElapsedMs(
        { ...settled, lastRunDurationMs: 42_250 },
        { tone: 'complete', title: 'Turn completed' },
        Date.parse('2026-08-05T14:00:00.000Z'),
      ),
    ).toBe(42_250);
  });

  it('freezes failed turns at the terminal status timestamp', () => {
    expect(
      resolveActivityElapsedMs(
        {
          ...chat,
          status: 'error',
          statusUpdatedAt: '2026-08-05T12:00:30.000Z',
          lastRunStartedAt: '2026-08-05T12:00:00.000Z',
        },
        { tone: 'error', title: 'Turn failed' },
        Date.parse('2026-08-05T13:00:00.000Z'),
      ),
    ).toBe(30_000);
  });

  it('freezes a locally observed duration when terminal timestamps are unavailable', () => {
    expect(
      resolveActivityElapsedMs(
        { ...chat, status: 'complete' },
        { tone: 'complete', title: 'Turn completed' },
        Date.parse('2026-08-05T13:00:00.000Z'),
        { startedAtMs: Date.parse('2026-08-05T12:00:00.000Z'), elapsedMs: 12_500 },
      ),
    ).toBe(12_500);
  });

  it('omits elapsed time from unrelated activity rows', () => {
    expect(
      resolveActivityElapsedMs(chat, { tone: 'idle', title: 'Waiting for approval' }, Date.now()),
    ).toBeNull();
    expect(
      resolveActivityElapsedMs(
        { ...chat, status: 'error' },
        { tone: 'error', title: 'Bridge disconnected' },
        Date.now(),
      ),
    ).toBeNull();
  });

  it('formats compact visual and spoken durations', () => {
    expect(formatActivityElapsedTime(5_900)).toBe('5s');
    expect(formatActivityElapsedTime(65_000)).toBe('1m 5s');
    expect(formatActivityElapsedTime(10 * 86_400_000 + 5 * 3_600_000 + 25 * 60_000 + 59_000)).toBe(
      '10d 5h 25m 59s',
    );
    expect(formatActivityElapsedAccessibilityLabel(3_665_000)).toBe('1 hour 1 minute 5 seconds');
  });
});
