import {
  classifyExecutionCommand,
  resolveToolInvocationIcon,
  type ExecutionIconCategory,
} from './toolInvocationIcon';

describe('classifyExecutionCommand', () => {
  it.each([
    ['database', 'sqlite3 app.db'],
    ['database', '"/usr/local/bin/psql" app'],
    ['database', 'DATABASE_URL="local db" env MODE=read mongosh'],
    ['database', '"C:\\tools\\sqlite3.exe" app.db'],
    ['git', 'git status'],
    ['git', 'gh pr view'],
    ['git', 'sudo git status'],
    ['container', 'docker ps'],
    ['container', '/usr/local/bin/kubectl get pods'],
    ['network', 'curl https://example.test'],
    ['network', 'http GET https://example.test'],
    ['test', 'pytest -q'],
    ['test', 'cargo --locked test'],
    ['test', 'go test ./...'],
    ['test', 'time cargo test'],
    ['test', 'pnpm --filter @dappercode/mobile run test'],
    ['test', 'pnpm exec vitest'],
    ['test', 'xcrun xcodebuild test -scheme DapperCode'],
    ['test', './gradlew testDebugUnitTest'],
    ['build', 'cargo build'],
    ['build', 'go build ./...'],
    ['build', 'pnpm run build'],
    ['build', 'xcodebuild archive -scheme DapperCode'],
    ['build', './gradlew assembleDebug'],
    ['build', 'make'],
    ['shell', 'echo sqlite3'],
    ['shell', 'echo sqlite3 && git status'],
    ['shell', 'sqlite3-backup app.db'],
    ['shell', 'pnpm add test'],
    ['shell', 'cargo run -- test'],
    ['shell', 'node script.js'],
  ] satisfies Array<[ExecutionIconCategory, string]>)(
    'classifies %s commands: %s',
    (category, command) => {
      expect(classifyExecutionCommand(command)).toBe(category);
    },
  );
});

describe('resolveToolInvocationIcon', () => {
  it('maps command categories to a consistent semantic icon set', () => {
    expect(
      resolveToolInvocationIcon({ kind: 'execute', title: 'sqlite3 app.db', isError: false }),
    ).toEqual({
      family: 'material-community',
      name: 'database-outline',
      tone: 'muted',
    });
    expect(
      resolveToolInvocationIcon({ kind: 'execute', title: 'git status', isError: false }),
    ).toEqual({
      family: 'ionicons',
      name: 'git-branch-outline',
      tone: 'muted',
    });
    expect(
      resolveToolInvocationIcon({ kind: 'execute', title: 'docker ps', isError: false }),
    ).toEqual({
      family: 'ionicons',
      name: 'cube-outline',
      tone: 'muted',
    });
    expect(
      resolveToolInvocationIcon({ kind: 'execute', title: 'curl example.test', isError: false }),
    ).toEqual({
      family: 'ionicons',
      name: 'globe-outline',
      tone: 'muted',
    });
    expect(resolveToolInvocationIcon({ kind: 'execute', title: 'pytest', isError: false })).toEqual(
      {
        family: 'ionicons',
        name: 'flask-outline',
        tone: 'muted',
      },
    );
    expect(
      resolveToolInvocationIcon({ kind: 'execute', title: 'cargo build', isError: false }),
    ).toEqual({
      family: 'ionicons',
      name: 'hammer-outline',
      tone: 'muted',
    });
  });

  it('preserves generic kind fallbacks and gives failures highest priority', () => {
    expect(
      resolveToolInvocationIcon({ kind: 'execute', title: 'node script.js', isError: false }),
    ).toMatchObject({ family: 'ionicons', name: 'terminal-outline', tone: 'muted' });
    expect(
      resolveToolInvocationIcon({ kind: 'switch_mode', title: 'sqlite3 app.db', isError: false }),
    ).toMatchObject({ family: 'ionicons', name: 'swap-horizontal-outline', tone: 'muted' });
    expect(
      resolveToolInvocationIcon({ kind: 'execute', title: 'sqlite3 app.db', isError: true }),
    ).toEqual({
      family: 'ionicons',
      name: 'alert-circle-outline',
      tone: 'error',
    });
  });
});
