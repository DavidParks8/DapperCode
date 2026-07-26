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
    if (block.type === 'text') {
      const text = normalizeCollapsedSummary(block.text);
      if (text) {
        return text;
      }
    }
    if (block.type === 'markdown') {
      const text = normalizeCollapsedSummary(block.markdown);
      if (text) {
        return text;
      }
    }
    if (block.type === 'checklist') {
      const item = block.items.find((entry) => normalizeCollapsedSummary(entry.label));
      if (item) {
        return normalizeCollapsedSummary(item.label);
      }
    }
    if (block.type === 'progress') {
      return normalizeCollapsedSummary(block.label);
    }
    if (block.type === 'keyValue') {
      const item = block.items[0];
      if (item) {
        return normalizeCollapsedSummary(`${item.label}: ${item.value}`);
      }
    }
    if (block.type === 'code') {
      const text = normalizeCollapsedSummary(block.text);
      if (text) {
        return text;
      }
    }
  }

  return normalizeCollapsedSummary(surface.subtitle ?? '');
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
