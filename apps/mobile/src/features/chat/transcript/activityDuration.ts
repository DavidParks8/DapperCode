import { useEffect, useState } from 'react';

import type { Chat } from '@bridge/types/types';
import type { ActivityState } from '../helpers/helpers';

const ACTIVITY_DURATION_TICK_MS = 1_000;
const TERMINAL_ACTIVITY_TITLES = new Set(['turn completed', 'turn failed', 'turn stopped']);

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

interface ActivityTimingFallback {
  startedAtMs: number | null;
  elapsedMs: number | null;
}

function isTerminalTurnActivity(chat: Chat, activity: ActivityState): boolean {
  return (
    (chat.status === 'complete' || chat.status === 'error') &&
    (activity.tone === 'complete' || activity.tone === 'error') &&
    TERMINAL_ACTIVITY_TITLES.has(activity.title.trim().toLowerCase())
  );
}

export function resolveActivityElapsedMs(
  chat: Chat,
  activity: ActivityState | null,
  nowMs: number,
  fallback: ActivityTimingFallback = { startedAtMs: null, elapsedMs: null },
): number | null {
  if (!activity) {
    return null;
  }

  const running = activity.tone === 'running';
  const terminal = isTerminalTurnActivity(chat, activity);
  if (!running && !terminal) {
    return null;
  }

  const lastRunDurationMs = chat.lastRunDurationMs;
  if (
    terminal &&
    typeof lastRunDurationMs === 'number' &&
    Number.isFinite(lastRunDurationMs) &&
    lastRunDurationMs >= 0
  ) {
    return Math.floor(lastRunDurationMs);
  }

  const authoritativeStartedAt = parseTimestamp(chat.lastRunStartedAt);
  if (terminal) {
    const authoritativeFinishedAt =
      parseTimestamp(chat.lastRunFinishedAt) ?? parseTimestamp(chat.statusUpdatedAt);
    if (authoritativeStartedAt != null && authoritativeFinishedAt != null) {
      return Math.max(0, Math.floor(authoritativeFinishedAt - authoritativeStartedAt));
    }
    return fallback.elapsedMs;
  }

  const startedAt = authoritativeStartedAt ?? fallback.startedAtMs;
  return startedAt == null ? null : Math.max(0, Math.floor(nowMs - startedAt));
}

export function formatActivityElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${String(days)}d`);
  }
  if (hours > 0) {
    parts.push(`${String(hours)}h`);
  }
  if (minutes > 0) {
    parts.push(`${String(minutes)}m`);
  }
  parts.push(`${String(seconds)}s`);
  return parts.join(' ');
}

export function formatActivityElapsedAccessibilityLabel(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`);
  }
  if (minutes > 0) {
    parts.push(`${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`);
  }
  return parts.join(' ');
}

export function useActivityElapsedMs(chat: Chat, activity: ActivityState | null): number | null {
  const running = activity?.tone === 'running';
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [localTiming, setLocalTiming] = useState({
    chatId: chat.id,
    tracking: false,
    localStartedAtMs: null as number | null,
    frozenElapsedMs: null as number | null,
  });
  const timingMatchesChat = localTiming.chatId === chat.id;
  const localStartedAtMs =
    timingMatchesChat && localTiming.tracking ? localTiming.localStartedAtMs : null;
  const fallbackElapsedMs = timingMatchesChat
    ? localTiming.tracking && localTiming.localStartedAtMs != null
      ? Math.max(0, nowMs - localTiming.localStartedAtMs)
      : localTiming.frozenElapsedMs
    : null;
  const elapsedMs = resolveActivityElapsedMs(chat, activity, nowMs, {
    startedAtMs: localStartedAtMs,
    elapsedMs: fallbackElapsedMs,
  });

  useEffect(() => {
    if (running) {
      const startedAtMs = Date.now();
      setNowMs(startedAtMs);
      setLocalTiming((previous) =>
        previous.chatId === chat.id && previous.tracking
          ? previous
          : {
              chatId: chat.id,
              tracking: true,
              localStartedAtMs: startedAtMs,
              frozenElapsedMs: null,
            },
      );
      const interval = setInterval(() => setNowMs(Date.now()), ACTIVITY_DURATION_TICK_MS);
      return () => clearInterval(interval);
    }

    // The turn is over. Freeze whatever this device measured instead of discarding it: the
    // thread status that promotes the row to "Turn completed" routinely lands a frame or two
    // after the activity settles, and wiping the timer in that gap left the finished turn with
    // no duration at all. Only a different chat, or the next run, starts the clock over.
    setLocalTiming((previous) => {
      if (previous.chatId !== chat.id) {
        return {
          chatId: chat.id,
          tracking: false,
          localStartedAtMs: null,
          frozenElapsedMs: null,
        };
      }
      if (!previous.tracking || previous.localStartedAtMs == null) {
        return previous;
      }
      return {
        ...previous,
        tracking: false,
        frozenElapsedMs: Math.max(0, Date.now() - previous.localStartedAtMs),
      };
    });
    return undefined;
  }, [chat.id, running]);
  return elapsedMs;
}
