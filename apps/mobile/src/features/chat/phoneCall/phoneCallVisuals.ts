import { useEffect, useState } from 'react';
import type { Ionicons } from '@expo/vector-icons';

import type { AppTheme } from '@shared/theme';
import type {
  PhoneCallActivityKind,
  PhoneCallModel,
  PhoneCallPhase,
} from '../approvals/phoneCallModel';

/** Ticks locally between bridge updates; the bridge's duration stays the source of truth. */
export function useCallElapsedSeconds(
  model: PhoneCallModel,
  receivedAt: number | undefined,
): number | null {
  const running = model.phase === 'live' || model.phase === 'held';
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, receivedAt]);

  if (model.durationSeconds === null || !running) {
    return model.durationSeconds;
  }
  const sinceReceived = receivedAt === undefined ? 0 : Math.max(0, now - receivedAt);
  return model.durationSeconds + Math.floor(sinceReceived / 1000);
}

export function phaseColor(theme: AppTheme, phase: PhoneCallPhase): string {
  switch (phase) {
    case 'live':
      return theme.colors.success;
    case 'held':
      return theme.colors.warning;
    case 'failed':
      return theme.colors.error;
    case 'connecting':
      return theme.colors.textSecondary;
    case 'ended':
      return theme.colors.textMuted;
  }
}

export function phaseBackground(theme: AppTheme, phase: PhoneCallPhase): string {
  switch (phase) {
    case 'live':
      return theme.colors.successBg;
    case 'held':
      return theme.colors.warningBg;
    case 'failed':
      return theme.colors.errorBg;
    case 'connecting':
    case 'ended':
      return theme.colors.bgMain;
  }
}

export function activityColor(
  theme: AppTheme,
  phase: PhoneCallPhase,
  activity: PhoneCallActivityKind,
): string {
  if (activity === 'running_tool') {
    return theme.colors.accent;
  }
  return phaseColor(theme, phase);
}

export function activityBackground(
  theme: AppTheme,
  phase: PhoneCallPhase,
  activity: PhoneCallActivityKind,
): string {
  if (activity === 'running_tool') {
    return theme.colors.bgCanvasAccent;
  }
  return phaseBackground(theme, phase);
}

export function activityIconName(
  phase: PhoneCallPhase,
  activity: PhoneCallActivityKind,
): keyof typeof Ionicons.glyphMap {
  if (activity === 'on_hold' || phase === 'held') {
    return 'pause';
  }
  if (activity === 'agent_speaking') {
    return 'volume-high-outline';
  }
  if (activity === 'recipient_speaking') {
    return 'mic-outline';
  }
  if (activity === 'running_tool') {
    return 'construct-outline';
  }
  if (phase === 'failed') {
    return 'alert-circle-outline';
  }
  return 'call';
}

export function emptyCallTranscriptText(phase: PhoneCallPhase): string {
  switch (phase) {
    case 'connecting':
      return 'The live transcript starts once the call connects.';
    case 'live':
    case 'held':
      return 'Waiting for the first words on the line…';
    case 'ended':
    case 'failed':
      return 'Nothing was said on this call.';
  }
}
