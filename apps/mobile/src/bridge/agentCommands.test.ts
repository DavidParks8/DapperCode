import { parseAgentCommands } from './agentCommands';

describe('parseAgentCommands', () => {
  it('keeps named commands and only non-blank string hints', () => {
    expect(
      parseAgentCommands({
        commands: [
          { name: 'review', description: 'Review changes', hint: ' [focus] ' },
          { name: 'compact', description: 'Compact' },
          { name: 'blank', description: 'Blank hint', hint: '   ' },
          { name: 'numeric', description: 'Numeric hint', hint: 7 },
          { name: 'nameless-description', description: 3, hint: null },
          { name: '  ', description: 'Blank name' },
          { description: 'Missing name' },
          'review',
          null,
        ],
      }),
    ).toEqual([
      { name: 'review', description: 'Review changes', hint: '[focus]' },
      { name: 'compact', description: 'Compact' },
      { name: 'blank', description: 'Blank hint' },
      { name: 'numeric', description: 'Numeric hint' },
      { name: 'nameless-description', description: '' },
    ]);
  });

  it('treats a missing or malformed command list as empty', () => {
    expect(parseAgentCommands(null)).toEqual([]);
    expect(parseAgentCommands({ commands: 'review' })).toEqual([]);
    expect(parseAgentCommands([{ name: 'review' }])).toEqual([]);
  });
});
