import type { Ionicons } from '@expo/vector-icons';

import { isComputerUseTraceEntry } from './computerUseTrace';
import type { TimelineEntry, ToolGroupEntry } from './chatMessageTypes';

export function parseTimelineEntries(content: string): TimelineEntry[] | null {
  if (!content.includes('•')) return null;
  const entries: TimelineEntry[] = [];
  let current: TimelineEntry | null = null;
  const commitCurrent = () => {
    if (current?.title) entries.push(current);
    current = null;
  };
  for (const line of content.split('\n')) {
    const headingMatch = line.match(/^\s*•\s+(.+)$/);
    if (headingMatch) {
      commitCurrent();
      current = { title: headingMatch[1].trim(), details: [] };
      continue;
    }
    if (!current) {
      if (line.trim()) return null;
      continue;
    }
    const detail = normalizeTimelineDetail(line);
    if (detail) current.details.push(detail);
  }
  commitCurrent();
  return entries.length > 0 ? entries : null;
}

function normalizeTimelineDetail(line: string): string | null {
  if (!line.trim()) return null;
  const withoutMarker = line.replace(/^\s*[└├│]\s*/, '').trimEnd();
  return withoutMarker.trim() ? withoutMarker : null;
}

export function entriesAreComputerUseTimeline(
  entries: Array<Pick<ToolGroupEntry, 'title'>>,
): boolean {
  return entries.length > 0 && entries.every((entry) => isComputerUseTraceEntry(entry));
}

export function formatCompactionLabel(content: string): string {
  const normalized = content.replace(/^\s*[•-]\s*/, '').trim();
  if (!normalized || /^compacted conversation context$/i.test(normalized)) {
    return 'Conversation compacted';
  }
  return normalized;
}

export function summarizeReasoningPreview(details: string[]): string | null {
  const preview = details
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return preview || null;
}

function stripLeadingTimelineBullet(title: string): string {
  return title
    .trim()
    .replace(/^[•\u2022]\s*/, '')
    .trim();
}

export function toTimelineVisual(title: string): {
  icon: keyof typeof Ionicons.glyphMap;
  useMonospaceTitle: boolean;
  isError: boolean;
} {
  const normalized = stripLeadingTimelineBullet(title).toLowerCase();
  const isError =
    normalized.includes('failed') || normalized.includes('error') || normalized.includes('aborted');
  if (isError) return { icon: 'alert-circle-outline', useMonospaceTitle: false, isError: true };
  if (normalized.startsWith('ran '))
    return { icon: 'play-outline', useMonospaceTitle: true, isError: false };
  if (normalized.startsWith('explored'))
    return { icon: 'search', useMonospaceTitle: false, isError: false };
  if (normalized.startsWith('called tool'))
    return { icon: 'construct-outline', useMonospaceTitle: false, isError: false };
  if (normalized.startsWith('searched web'))
    return { icon: 'globe-outline', useMonospaceTitle: false, isError: false };
  if (normalized.startsWith('reading'))
    return { icon: 'eye-outline', useMonospaceTitle: true, isError: false };
  if (normalized.startsWith('listing'))
    return { icon: 'folder-open-outline', useMonospaceTitle: false, isError: false };
  if (normalized.startsWith('applied file'))
    return { icon: 'create-outline', useMonospaceTitle: false, isError: false };
  return { icon: 'document-text-outline', useMonospaceTitle: false, isError: false };
}

export function toSubAgentVisual(title: string): {
  icon: keyof typeof Ionicons.glyphMap;
  isError: boolean;
} {
  const normalized = title.toLowerCase();
  const isError =
    normalized.includes('failed') || normalized.includes('error') || normalized.includes('aborted');
  if (isError) return { icon: 'alert-circle-outline', isError: true };
  if (normalized.includes('waiting')) return { icon: 'pause-circle-outline', isError: false };
  if (normalized.includes('closed')) return { icon: 'checkmark-circle-outline', isError: false };
  if (normalized.includes('spawn')) return { icon: 'sparkles-outline', isError: false };
  return { icon: 'git-branch-outline', isError: false };
}

export function isTerminalSubAgentStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase() ?? '';
  return [
    'completed',
    'complete',
    'succeeded',
    'failed',
    'error',
    'aborted',
    'cancelled',
    'canceled',
    'closed',
  ].includes(normalized);
}
