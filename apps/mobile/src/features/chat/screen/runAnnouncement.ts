import { useRef } from 'react';

import { useAccessibilityAnnouncement } from '@shared/accessibility';
import type { ActivityState } from '../state/runtime';

export interface RunAnnouncementInput {
  chatId: string | null;
  activeTurnId: string | null;
  activity: ActivityState;
  resolvedActivity: ActivityState;
}

export interface RunAnnouncementMemory {
  chatId: string | null;
  activeTurnId: string | null;
  /** The chat whose watched turn just finished, until another turn starts or the chat changes. */
  finishedChatId: string | null;
}

/**
 * What VoiceOver should hear about the run: a phase the agent reported (such as loading a model),
 * and completion only when a turn this screen watched running finishes. Shell transitions
 * ("Opening chat", "Sending message") and an already-settled chat's state are never announced, and
 * failures are announced by the composer alert.
 */
export function resolveRunAnnouncement(
  memory: RunAnnouncementMemory | null,
  current: RunAnnouncementInput,
): { announcement: string | null; memory: RunAnnouncementMemory } {
  const sameChat = memory?.chatId === current.chatId;
  const turnJustEnded = sameChat && memory?.activeTurnId != null && current.activeTurnId === null;
  const finishedChatId =
    current.activeTurnId !== null || !sameChat
      ? null
      : turnJustEnded
        ? current.chatId
        : (memory?.finishedChatId ?? null);
  const next = { chatId: current.chatId, activeTurnId: current.activeTurnId, finishedChatId };
  if (current.activity.tone === 'running' && current.activity.announce) {
    return { announcement: current.activity.title, memory: next };
  }
  const completed =
    finishedChatId !== null && current.resolvedActivity.tone === 'complete'
      ? current.resolvedActivity.title
      : null;
  return { announcement: completed, memory: next };
}

export function useRunAnnouncement(current: RunAnnouncementInput): void {
  const memoryRef = useRef<RunAnnouncementMemory | null>(null);
  const { announcement, memory } = resolveRunAnnouncement(memoryRef.current, current);
  memoryRef.current = memory;
  useAccessibilityAnnouncement(announcement);
}
