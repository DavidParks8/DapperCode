import type { Ionicons } from '@expo/vector-icons';

import type { BridgeUiSurface } from '../api/types';
import type { AppTheme } from '../theme';

export function getChecklistGlyph(status: string | undefined): string {
  if (status === 'completed') {
    return '✓';
  }
  if (status === 'inProgress') {
    return '•';
  }
  return '○';
}

export function getSurfaceIconName(surface: BridgeUiSurface): keyof typeof Ionicons.glyphMap {
  if (surface.kind === 'goal') {
    return 'flag-outline';
  }
  if (surface.tone === 'warning') {
    return 'warning-outline';
  }
  if (surface.tone === 'error') {
    return 'alert-circle-outline';
  }
  if (surface.tone === 'success') {
    return 'checkmark-circle-outline';
  }
  return 'layers-outline';
}

export function getToneColor(theme: AppTheme, surface: BridgeUiSurface): string {
  if (surface.tone === 'warning') {
    return theme.colors.warning;
  }
  if (surface.tone === 'error') {
    return theme.colors.error;
  }
  if (surface.tone === 'success') {
    return theme.colors.success;
  }
  return theme.colors.textPrimary;
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function getSurfaceCollapsedSummary(surface: BridgeUiSurface): string {
  const bodySummary = normalizeCollapsedSummary(surface.bodyMarkdown ?? '');
  if (bodySummary) {
    return bodySummary;
  }

  for (const block of surface.blocks) {
    const summary = getBlockCollapsedSummary(block);
    if (summary) return summary;
  }

  return normalizeCollapsedSummary(surface.subtitle ?? '');
}

function getBlockCollapsedSummary(surface: BridgeUiSurface['blocks'][number]): string {
  switch (surface.type) {
    case 'text':
    case 'code':
      return normalizeCollapsedSummary(surface.text);
    case 'markdown':
      return normalizeCollapsedSummary(surface.markdown);
    case 'checklist':
      return normalizeCollapsedSummary(surface.items.find((item) => item.label)?.label ?? '');
    case 'progress':
      return normalizeCollapsedSummary(surface.label);
    case 'keyValue': {
      const item = surface.items[0];
      return item ? normalizeCollapsedSummary(`${item.label}: ${item.value}`) : '';
    }
  }
}

function normalizeCollapsedSummary(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~#>-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
