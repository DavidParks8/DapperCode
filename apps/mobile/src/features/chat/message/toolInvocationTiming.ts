import { useEffect, useState } from 'react';

const TOOL_DURATION_TICK_MS = 1_000;

export function formatToolStartTime(startedAtMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(startedAtMs));
}

export function resolveToolElapsedMs(
  startedAtMs: number | null,
  completedAtMs: number | null,
  nowMs: number,
): number | null {
  if (!isValidTimestamp(startedAtMs)) {
    return null;
  }
  const endAtMs = isValidTimestamp(completedAtMs) ? completedAtMs : nowMs;
  return Math.max(0, Math.floor(endAtMs - startedAtMs));
}

export function useToolElapsedMs(
  startedAtMs: number | null,
  completedAtMs: number | null,
): number | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const running = isValidTimestamp(startedAtMs) && !isValidTimestamp(completedAtMs);

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    setNowMs(Date.now());
    const interval = setInterval(() => setNowMs(Date.now()), TOOL_DURATION_TICK_MS);
    return () => clearInterval(interval);
  }, [running, startedAtMs]);

  return resolveToolElapsedMs(startedAtMs, completedAtMs, nowMs);
}

function isValidTimestamp(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}
