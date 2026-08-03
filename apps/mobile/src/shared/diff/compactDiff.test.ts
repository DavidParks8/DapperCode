import { buildCompactDiff } from './compactDiff';

describe('buildCompactDiff', () => {
  it('keeps bounded context around one changed region and reports truthful counts', () => {
    const before = ['one', 'two', 'three', 'old', 'five', 'six', 'seven'].join('\n');
    const after = ['one', 'two', 'three', 'new', 'five', 'six', 'seven'].join('\n');

    expect(buildCompactDiff(before, after)).toEqual({
      lines: [
        { kind: 'context', prefix: ' ', content: 'one' },
        { kind: 'context', prefix: ' ', content: 'two' },
        { kind: 'context', prefix: ' ', content: 'three' },
        { kind: 'remove', prefix: '-', content: 'old' },
        { kind: 'add', prefix: '+', content: 'new' },
        { kind: 'context', prefix: ' ', content: 'five' },
        { kind: 'context', prefix: ' ', content: 'six' },
        { kind: 'context', prefix: ' ', content: 'seven' },
      ],
      additions: 1,
      deletions: 1,
      omittedChangedLines: 0,
      unavailable: false,
    });
  });

  it('handles file creation, deletion, and identical text without inventing changes', () => {
    expect(buildCompactDiff(null, 'one\ntwo\n')).toMatchObject({
      additions: 2,
      deletions: 0,
      unavailable: false,
    });
    expect(buildCompactDiff('one\ntwo\n', '')).toMatchObject({
      additions: 0,
      deletions: 2,
      unavailable: false,
    });
    expect(buildCompactDiff('same\n', 'same\n')).toEqual({
      lines: [],
      additions: 0,
      deletions: 0,
      omittedChangedLines: 0,
      unavailable: false,
    });
  });

  it('bounds large changed regions and rejects bridge-limit-shaped text', () => {
    const changed = Array.from({ length: 50 }, (_, index) => `line ${String(index)}`).join('\n');
    const compact = buildCompactDiff('', changed);
    expect(compact.lines).toHaveLength(40);
    expect(compact.additions).toBe(50);
    expect(compact.omittedChangedLines).toBe(10);

    expect(buildCompactDiff('x'.repeat(16 * 1024), 'replacement')).toMatchObject({
      unavailable: true,
      lines: [],
    });
  });

  it('shows both sides of a large replacement within the changed-line budget', () => {
    const before = Array.from({ length: 60 }, (_, index) => `old ${String(index)}`).join('\n');
    const after = Array.from({ length: 60 }, (_, index) => `new ${String(index)}`).join('\n');
    const compact = buildCompactDiff(before, after);

    expect(compact.lines).toHaveLength(40);
    expect(compact.lines.filter((line) => line.kind === 'remove')).toHaveLength(20);
    expect(compact.lines.filter((line) => line.kind === 'add')).toHaveLength(20);
    expect(compact.omittedChangedLines).toBe(80);
  });
});
