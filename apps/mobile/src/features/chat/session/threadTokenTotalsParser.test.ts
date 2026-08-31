import { parseThreadSessionTokenTotals } from './threadSnapshotStore';

describe('parseThreadSessionTokenTotals', () => {
  it('parses camelCase and snake_case cumulative payloads', () => {
    expect(
      parseThreadSessionTokenTotals({
        tokenTotals: {
          turns: 14,
          inputTokens: 48200,
          outputTokens: 12400,
          reasoningTokens: 8900,
          cachedReadTokens: 386000,
          cachedWriteTokens: 52300,
          totalTokens: 507800,
        },
      }),
    ).toMatchObject({
      turns: 14,
      inputTokens: 48200,
      outputTokens: 12400,
      reasoningTokens: 8900,
      cachedReadTokens: 386000,
      cachedWriteTokens: 52300,
      totalTokens: 507800,
    });
    expect(
      parseThreadSessionTokenTotals({
        turns: 2,
        input_tokens: 20,
        output_tokens: 10,
        reasoning_tokens: 4,
        cached_read_tokens: 100,
        cached_write_tokens: 6,
        total_tokens: 140,
      }),
    ).toMatchObject({
      turns: 2,
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 4,
      cachedReadTokens: 100,
      cachedWriteTokens: 6,
      totalTokens: 140,
    });
  });

  it('keeps missing optional categories unreported and rejects malformed totals', () => {
    expect(
      parseThreadSessionTokenTotals({
        turns: 1,
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      }),
    ).toMatchObject({
      reasoningTokens: null,
      cachedReadTokens: null,
      cachedWriteTokens: null,
    });
    expect(parseThreadSessionTokenTotals({ turns: 1, inputTokens: 20 })).toBeNull();
    expect(parseThreadSessionTokenTotals(null)).toBeNull();
  });
});
