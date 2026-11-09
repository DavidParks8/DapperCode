import { OnDeviceNativeError } from '../native/services.errors';
import {
  catalogUrl,
  loadSkillConfig,
  parseJsonc,
  skillPatternMatches,
  skillPermission,
  type LocalSkillSourcedRule,
} from './skillConfig';

function configNative(files: Record<string, string>) {
  return {
    readWorkspaceFile: jest.fn(
      async (_workspace: string, path: string, _offset: number, limit: number) => {
        const content = files[path];
        if (content === undefined) {
          throw new OnDeviceNativeError('PATH_NOT_FOUND', 'The path does not exist.');
        }
        return {
          path,
          content: content.slice(0, limit),
          revision: 'rev',
          nextOffset: content.length > limit ? limit : null,
          totalBytes: content.length,
        };
      },
    ),
  };
}

test.each([
  ['line and block comments', '// head\n{ /* a */ "a": 1 // tail\n}', { a: 1 }],
  [
    'trailing commas in nested arrays and objects',
    '{"a": [1, 2,], "b": {"c": 3,},}',
    { a: [1, 2], b: { c: 3 } },
  ],
  ['a comment between a trailing comma and the bracket', '[1, // more\n /* x */ ]', [1]],
  [
    'comment and comma markers inside strings',
    '{"u": "https://x//y", "s": "/* no */", "t": ",]"}',
    { u: 'https://x//y', s: '/* no */', t: ',]' },
  ],
  [
    'escaped quotes and backslashes in strings',
    '{"q": "a\\"//b", "r": "c\\\\", "z": 1,}',
    { q: 'a"//b', r: 'c\\', z: 1 },
  ],
  ['a byte order mark and a final line comment', '\uFEFF{"a": true} // done', { a: true }],
  ['plain JSON', '{"skills": ["./x"]}', { skills: ['./x'] }],
])('JSONC parses %s', (_name, text, expected) => {
  expect(parseJsonc(text)).toEqual(expected);
});

test.each([
  ['an unterminated block comment', '{"a": 1 /* open'],
  ['a comma that is not trailing', '{"a": 1,, }'],
  ['single quotes', "{'a': 1}"],
  ['an unterminated string', '{"a": "open}'],
])('JSONC rejects %s', (_name, text) => {
  expect(() => parseJsonc(text)).toThrow(SyntaxError);
});

test('skill patterns are whole-value, case-sensitive wildcards with literal regex characters', () => {
  expect(skillPatternMatches('*', 'anything')).toBe(true);
  expect(skillPatternMatches('internal-*', 'internal-docs')).toBe(true);
  expect(skillPatternMatches('internal-*', 'my-internal-docs')).toBe(false);
  expect(skillPatternMatches('exp-?', 'exp-a')).toBe(true);
  expect(skillPatternMatches('exp-?', 'exp-ab')).toBe(false);
  expect(skillPatternMatches('v1.2', 'v1x2')).toBe(false);
  expect(skillPatternMatches('a+(b)', 'a+(b)')).toBe(true);
  expect(skillPatternMatches('Review', 'review')).toBe(false);
});

test('the last matching rule wins and no match allows', () => {
  const rules: LocalSkillSourcedRule[] = [
    { pattern: '*', effect: 'deny', origin: 'a' },
    { pattern: 'docs-*', effect: 'ask', origin: 'b' },
    { pattern: 'docs-public', effect: 'allow', origin: 'c' },
  ];
  expect(skillPermission(rules, 'docs-public')).toEqual({ effect: 'allow', rule: rules[2] });
  expect(skillPermission(rules, 'docs-private')).toEqual({ effect: 'ask', rule: rules[1] });
  expect(skillPermission(rules, 'other')).toEqual({ effect: 'deny', rule: rules[0] });
  expect(skillPermission([], 'other')).toEqual({ effect: 'allow', rule: null });
});

test('catalog URLs must be plain https and are normalized to a directory', () => {
  expect(catalogUrl('https://example.com/skills')).toBe('https://example.com/skills/');
  expect(catalogUrl(' https://example.com/skills/ ')).toBe('https://example.com/skills/');
  for (const url of [
    'http://example.com/',
    'https://u:p@example.com/',
    'https://x.example/?a=1',
    'nope',
  ]) {
    expect(() => catalogUrl(url)).toThrow(/https:\/\//u);
  }
});

test('config skill sources stay inside the workspace; home, absolute, and non-HTTPS entries are diagnostics', async () => {
  const native = configNative({
    'opencode.jsonc': `{
      // team sources
      "skills": [
        "./team-skills/", ".", "nested/dir", "../outside", "a/../../b", "~/shared", "/opt/skills",
        "http://plain.example/skills/", "ftp://files.example/", "https://cat.example/skills", 42,
      ],
    }`,
    '.opencode/opencode.json': '{"skills": ["shared"]}',
  });
  const config = await loadSkillConfig(native, 'ws');
  expect(config.sources).toEqual([
    { kind: 'path', root: 'team-skills', file: 'opencode.jsonc' },
    { kind: 'path', root: '', file: 'opencode.jsonc' },
    { kind: 'path', root: 'nested/dir', file: 'opencode.jsonc' },
    { kind: 'catalog', url: 'https://cat.example/skills/', file: 'opencode.jsonc' },
    { kind: 'path', root: 'shared', file: '.opencode/opencode.json' },
  ]);
  expect(config.problems.map((problem) => problem.message)).toEqual([
    expect.stringMatching(/^\.\.\/outside: Paths must stay inside the workspace/u),
    expect.stringMatching(/^a\/\.\.\/\.\.\/b: Paths must stay inside the workspace/u),
    '~/shared: home and absolute paths are unavailable on iPhone.',
    '/opt/skills: home and absolute paths are unavailable on iPhone.',
    'http://plain.example/skills/: only https:// skill catalogs are supported.',
    'ftp://files.example/: only https:// skill catalogs are supported.',
    'skills entries must be paths or URLs.',
  ]);
  expect(native.readWorkspaceFile.mock.calls.map((call) => call[1])).toEqual([
    'opencode.json',
    'opencode.jsonc',
    '.opencode/opencode.json',
    '.opencode/opencode.jsonc',
  ]);
});

test('V1 and V2 skill permissions merge in file order with per-agent rules and tools.skill', async () => {
  const config = await loadSkillConfig(
    configNative({
      'opencode.json': JSON.stringify({
        permission: { skill: { '*': 'allow', 'internal-*': 'deny' }, edit: 'deny' },
        permissions: [
          { action: 'read', resource: '*', effect: 'deny' },
          { action: 'skill', resource: 'internal-docs', effect: 'allow' },
          { action: 'sk*', resource: 'beta-*', effect: 'ask' },
          { action: 'skill', resource: 'x', effect: 'maybe' },
        ],
        agent: {
          explore: { tools: { skill: false } },
          general: { permission: { skill: 'ask' } },
          plan: { permission: { skill: 'deny' } },
        },
        agents: {
          build: { permissions: [{ action: 'skill', resource: 'secret', effect: 'deny' }] },
        },
      }),
      '.opencode/opencode.jsonc': '{ "permission": "deny", /* all */ }',
    }),
    'ws',
  );
  expect(config.rules.map((rule) => [rule.pattern, rule.effect, rule.origin])).toEqual([
    ['*', 'allow', 'opencode.json permission.skill'],
    ['internal-*', 'deny', 'opencode.json permission.skill'],
    ['internal-docs', 'allow', 'opencode.json permissions[1]'],
    ['beta-*', 'ask', 'opencode.json permissions[2]'],
    ['*', 'deny', '.opencode/opencode.jsonc permission'],
  ]);
  expect(config.agents.general.rules.map((rule) => [rule.pattern, rule.effect])).toEqual([
    ['*', 'ask'],
  ]);
  expect(config.agents.build.rules.map((rule) => rule.origin)).toEqual([
    'opencode.json agents.build.permissions[0]',
  ]);
  expect(config.agents.explore.toolDisabled).toBe(true);
  expect(config.agents.build.toolDisabled).toBe(false);
  expect(config.problems.map((problem) => problem.message)).toEqual([
    'permissions[3]: rules need a 1-128 character pattern and allow, ask, or deny.',
    'agent.explore.tools.skill is false: skills are off for explore.',
  ]);
});

test('an invalid, oversized, or non-object config is skipped with a diagnostic', async () => {
  const config = await loadSkillConfig(
    configNative({
      'opencode.json': '{"skills": [',
      'opencode.jsonc': `{"skills": ["${'x'.repeat(70_000)}"]}`,
      '.opencode/opencode.json': '[]',
    }),
    'ws',
  );
  expect(config.sources).toEqual([]);
  expect(config.problems).toEqual([
    { location: 'opencode.json', message: expect.stringMatching(/^Skipped: /u) },
    { location: 'opencode.jsonc', message: 'Skipped: larger than 65536 bytes.' },
    { location: '.opencode/opencode.json', message: 'Skipped: the config must be a JSON object.' },
  ]);
});
