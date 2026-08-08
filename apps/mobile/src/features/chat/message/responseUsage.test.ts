import {
  buildResponseUsageStats,
  buildResponseUsageSummary,
  computeCachedInputRatio,
  formatCachedPercentage,
} from './responseUsage';
import type { MessageTokenUsage } from '@bridge/types/types';

function usage(overrides: Partial<MessageTokenUsage> = {}): MessageTokenUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: null,
    cachedReadTokens: null,
    cachedWriteTokens: null,
    totalTokens: 120,
    model: null,
    ...overrides,
  };
}

describe('computeCachedInputRatio', () => {
  it('measures cache reads against everything the prompt sent', () => {
    expect(computeCachedInputRatio(usage({ inputTokens: 250, cachedReadTokens: 750 }))).toBe(0.75);
  });

  it('reports nothing when the agent never mentions caching', () => {
    expect(computeCachedInputRatio(usage({ cachedReadTokens: null }))).toBeNull();
  });

  it('reports nothing rather than dividing by an empty prompt', () => {
    expect(computeCachedInputRatio(usage({ inputTokens: 0, cachedReadTokens: 0 }))).toBeNull();
  });
});

describe('formatCachedPercentage', () => {
  it('rounds to whole percents', () => {
    expect(formatCachedPercentage(0.5)).toBe('50%');
    expect(formatCachedPercentage(1)).toBe('100%');
    expect(formatCachedPercentage(0)).toBe('0%');
  });

  it('never rounds a partial cache into an absolute', () => {
    expect(formatCachedPercentage(0.9997)).toBe('99%');
    expect(formatCachedPercentage(0.0001)).toBe('<1%');
  });
});

describe('buildResponseUsageStats', () => {
  it('reads model, input, output, and cache share in order', () => {
    expect(
      buildResponseUsageStats(
        usage({
          model: 'GPT-5.6 Sol',
          inputTokens: 12_400,
          outputTokens: 1_280,
          cachedReadTokens: 111_600,
        }),
      ).map((stat) => [stat.label, stat.value]),
    ).toEqual([
      ['Model', 'GPT-5.6 Sol'],
      ['Input', '12,400'],
      ['Output', '1,280'],
      ['Cached', '90%'],
    ]);
  });

  it('drops the rows the turn did not report instead of showing blanks', () => {
    expect(buildResponseUsageStats(usage()).map((stat) => stat.key)).toEqual(['input', 'output']);
  });

  it('spells abbreviated values out for screen readers', () => {
    expect(buildResponseUsageSummary(usage({ inputTokens: 2_000, outputTokens: 30 }))).toBe(
      'Input: 2,000 tokens, Output: 30 tokens',
    );
  });
});
