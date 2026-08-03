import {
  highlightCode,
  highlightDiffCodeLines,
  resolveSyntaxLanguage,
  syntaxLanguageFromPath,
} from './syntaxHighlight';

describe('syntax highlighting', () => {
  it('preserves the nearest styled ancestor for nested Prism tokens', () => {
    const syntax = resolveSyntaxLanguage('bash');
    const highlighted = highlightCode('echo "$HOME"', syntax.grammar);

    expect(highlighted).not.toEqual(expect.any(String));
    if (typeof highlighted === 'string') {
      throw new Error('Expected highlighted Bash segments');
    }
    expect(highlighted.find((segment) => segment.content === '$HOME')).toMatchObject({
      type: 'string',
    });
  });

  it('keeps multiline syntax state across visible old and new diff runs', () => {
    const syntax = resolveSyntaxLanguage('typescript');
    const highlighted = highlightDiffCodeLines(
      [
        { kind: 'context', content: '/**' },
        { kind: 'remove', content: ' * before' },
        { kind: 'add', content: ' * after' },
        { kind: 'context', content: ' */' },
      ],
      syntax.grammar,
    );
    const addedLine = highlighted[2];

    expect(addedLine).not.toEqual(expect.any(String));
    if (typeof addedLine === 'string' || !addedLine) {
      throw new Error('Expected highlighted comment segments');
    }
    expect(addedLine).toEqual([{ content: ' * after', type: 'comment' }]);
  });

  it('infers common source extensions and leaves unknown paths neutral', () => {
    expect(syntaxLanguageFromPath('scripts/release.mjs')).toBe('javascript');
    expect(syntaxLanguageFromPath('src/component.tsx')).toBe('tsx');
    expect(syntaxLanguageFromPath('fixtures/data.unknown')).toBeNull();
  });
});
