import type { MessageTokenUsage } from '@bridge/types/types';

export interface ResponseUsageStat {
  key: string;
  label: string;
  value: string;
  /** The full reading of an abbreviated value, for screen readers. */
  accessibilityValue: string;
}

/**
 * The share of the prompt the agent did not have to pay full price for.
 *
 * Cache reads are reported alongside the fresh input tokens rather than inside them, so the
 * denominator is everything that was sent, not `inputTokens` on its own.
 */
export function computeCachedInputRatio(usage: MessageTokenUsage): number | null {
  if (usage.cachedReadTokens === null) {
    return null;
  }
  const promptTokens = usage.inputTokens + usage.cachedReadTokens;
  if (promptTokens <= 0) {
    return null;
  }
  return usage.cachedReadTokens / promptTokens;
}

/**
 * Rounds toward the nearest whole percent but never reports a full 100% while any part of the
 * prompt was uncached, nor 0% while any part of it was cached - a rounded extreme reads as an
 * absolute and would misdescribe the turn.
 */
export function formatCachedPercentage(ratio: number): string {
  const percentage = ratio * 100;
  const rounded = Math.round(percentage);
  if (rounded === 100 && percentage < 100) {
    return '99%';
  }
  if (rounded === 0 && percentage > 0) {
    return '<1%';
  }
  return `${String(rounded)}%`;
}

export function formatTokenCount(tokenCount: number): string {
  return tokenCount.toLocaleString();
}

/** The rows the response info panel shows, in reading order, skipping anything unreported. */
export function buildResponseUsageStats(usage: MessageTokenUsage): ResponseUsageStat[] {
  const stats: ResponseUsageStat[] = [];
  if (usage.model) {
    stats.push({
      key: 'model',
      label: 'Model',
      value: usage.model,
      accessibilityValue: usage.model,
    });
  }
  stats.push(
    {
      key: 'input',
      label: 'Input',
      value: formatTokenCount(usage.inputTokens),
      accessibilityValue: `${formatTokenCount(usage.inputTokens)} tokens`,
    },
    {
      key: 'output',
      label: 'Output',
      value: formatTokenCount(usage.outputTokens),
      accessibilityValue: `${formatTokenCount(usage.outputTokens)} tokens`,
    },
  );
  const cachedRatio = computeCachedInputRatio(usage);
  if (cachedRatio !== null) {
    stats.push({
      key: 'cached',
      label: 'Cached',
      value: formatCachedPercentage(cachedRatio),
      accessibilityValue: `${formatCachedPercentage(cachedRatio)} of the prompt`,
    });
  }
  return stats;
}

export function buildResponseUsageSummary(usage: MessageTokenUsage): string {
  return buildResponseUsageStats(usage)
    .map((stat) => `${stat.label}: ${stat.accessibilityValue}`)
    .join(', ');
}
