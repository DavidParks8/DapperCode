import type { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';

import type { ChatToolKind } from '@bridge/types/types';

type IoniconName = keyof typeof Ionicons.glyphMap;
type MaterialCommunityIconName = keyof typeof MaterialCommunityIcons.glyphMap;

export type ExecutionIconCategory =
  'database' | 'git' | 'container' | 'network' | 'test' | 'build' | 'shell';

export type ToolInvocationIcon =
  | {
      family: 'ionicons';
      name: IoniconName;
      tone: 'muted' | 'error';
    }
  | {
      family: 'material-community';
      name: MaterialCommunityIconName;
      tone: 'muted' | 'error';
    };

interface ParsedCommand {
  executable: string;
  args: string[];
}

const KIND_ICONS: Record<ChatToolKind, ToolInvocationIcon> = {
  read: { family: 'ionicons', name: 'document-text-outline', tone: 'muted' },
  edit: { family: 'ionicons', name: 'create-outline', tone: 'muted' },
  delete: { family: 'ionicons', name: 'trash-outline', tone: 'muted' },
  move: { family: 'ionicons', name: 'arrow-forward-outline', tone: 'muted' },
  search: { family: 'ionicons', name: 'search-outline', tone: 'muted' },
  execute: { family: 'ionicons', name: 'terminal-outline', tone: 'muted' },
  think: { family: 'ionicons', name: 'bulb-outline', tone: 'muted' },
  fetch: { family: 'ionicons', name: 'globe-outline', tone: 'muted' },
  switch_mode: { family: 'ionicons', name: 'swap-horizontal-outline', tone: 'muted' },
  other: { family: 'ionicons', name: 'construct-outline', tone: 'muted' },
};

const EXECUTION_ICONS: Record<ExecutionIconCategory, ToolInvocationIcon> = {
  database: { family: 'material-community', name: 'database-outline', tone: 'muted' },
  git: { family: 'ionicons', name: 'git-branch-outline', tone: 'muted' },
  container: { family: 'ionicons', name: 'cube-outline', tone: 'muted' },
  network: { family: 'ionicons', name: 'globe-outline', tone: 'muted' },
  test: { family: 'ionicons', name: 'flask-outline', tone: 'muted' },
  build: { family: 'ionicons', name: 'hammer-outline', tone: 'muted' },
  shell: KIND_ICONS.execute,
};

const ERROR_ICON: ToolInvocationIcon = {
  family: 'ionicons',
  name: 'alert-circle-outline',
  tone: 'error',
};

const EXECUTABLE_CATEGORIES: Partial<Record<string, ExecutionIconCategory>> = {
  duckdb: 'database',
  mariadb: 'database',
  mongo: 'database',
  mongosh: 'database',
  mysql: 'database',
  psql: 'database',
  'redis-cli': 'database',
  sqlite3: 'database',
  gh: 'git',
  git: 'git',
  docker: 'container',
  'docker-compose': 'container',
  helm: 'container',
  kubectl: 'container',
  podman: 'container',
  'podman-compose': 'container',
  curl: 'network',
  http: 'network',
  https: 'network',
  wget: 'network',
  xh: 'network',
};
const PACKAGE_MANAGERS = new Set(['bun', 'npm', 'pnpm', 'yarn']);
const PACKAGE_OPTIONS_WITH_VALUES = new Set([
  '-C',
  '-F',
  '--cwd',
  '--dir',
  '--filter',
  '--workspace',
]);
const TEST_RUNNERS = new Set(['jest', 'pytest', 'vitest']);
const ACTION_DRIVERS = new Set(['cargo', 'go']);
const GRADLE_EXECUTABLES = new Set(['gradle', 'gradlew']);
const DIRECT_BUILD_TOOLS = new Set(['cmake', 'make', 'ninja', 'xcodebuild']);
const SHELL_WORD_PATTERN = /(?:"(?:\\.|[^"])*"|'[^']*'|\\.|[^\s&|;\n"'])+/g;
const SHELL_OPERATOR_PATTERN = /[&|;\n]/;

export function classifyExecutionCommand(command: string): ExecutionIconCategory {
  const parsed = parseCommand(command);
  if (!parsed) {
    return 'shell';
  }
  // Tool identity wins before action rules, so `docker build` stays a container operation.
  const directCategory = EXECUTABLE_CATEGORIES[parsed.executable];
  if (directCategory) {
    return directCategory;
  }
  if (isTestCommand(parsed)) {
    return 'test';
  }
  return isBuildCommand(parsed) ? 'build' : 'shell';
}

export function resolveToolInvocationIcon(invocation: {
  kind: ChatToolKind;
  title: string;
  isError: boolean;
}): ToolInvocationIcon {
  if (invocation.isError) {
    return ERROR_ICON;
  }
  if (invocation.kind === 'execute') {
    return EXECUTION_ICONS[classifyExecutionCommand(invocation.title)];
  }
  return KIND_ICONS[invocation.kind] ?? KIND_ICONS.other;
}

function isTestCommand(command: ParsedCommand): boolean {
  if (TEST_RUNNERS.has(command.executable)) {
    return true;
  }
  const delegatedExecutable = readDelegatedExecutable(command);
  if (delegatedExecutable && TEST_RUNNERS.has(delegatedExecutable)) {
    return true;
  }
  const packageScript = readPackageScript(command);
  if (packageScript === 'test' || packageScript?.startsWith('test:')) {
    return true;
  }
  if (ACTION_DRIVERS.has(command.executable) && hasAction(command.args, 'test')) {
    return true;
  }
  if (command.executable === 'xcodebuild' && command.args.some(isXcodeTestAction)) {
    return true;
  }
  return GRADLE_EXECUTABLES.has(command.executable) && command.args.some((arg) => isTestTask(arg));
}

function isBuildCommand(command: ParsedCommand): boolean {
  const packageScript = readPackageScript(command);
  if (packageScript === 'build' || packageScript?.startsWith('build:')) {
    return true;
  }
  if (ACTION_DRIVERS.has(command.executable) && hasAction(command.args, 'build')) {
    return true;
  }
  if (GRADLE_EXECUTABLES.has(command.executable) && command.args.some((arg) => isBuildTask(arg))) {
    return true;
  }
  return DIRECT_BUILD_TOOLS.has(command.executable);
}

function hasAction(args: string[], action: string): boolean {
  const boundary = args.indexOf('--');
  const candidates = boundary === -1 ? args : args.slice(0, boundary);
  return candidates.some((arg) => arg.toLowerCase() === action);
}

function readPackageScript(command: ParsedCommand): string | null {
  if (!PACKAGE_MANAGERS.has(command.executable)) {
    return null;
  }
  let args = packagePositionalArgs(command.args);
  if (command.executable === 'yarn' && args[0]?.toLowerCase() === 'workspace') {
    args = args.slice(2);
  }
  const first = args[0]?.toLowerCase();
  if (first === 'run' || first === 'run-script') {
    return args[1]?.toLowerCase() ?? null;
  }
  return first ?? null;
}

function readDelegatedExecutable(command: ParsedCommand): string | null {
  const args = packagePositionalArgs(command.args);
  if (command.executable === 'npx' || command.executable === 'bunx') {
    return normalizeExecutable(args[0] ?? '');
  }
  if (!PACKAGE_MANAGERS.has(command.executable)) {
    return null;
  }
  const action = args[0]?.toLowerCase();
  return action === 'exec' || action === 'dlx' || action === 'x'
    ? normalizeExecutable(args[1] ?? '')
    : null;
}

function packagePositionalArgs(args: string[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('-') || arg === '--') {
      break;
    }
    const option = arg.split('=', 1)[0] ?? arg;
    index += PACKAGE_OPTIONS_WITH_VALUES.has(option) && !arg.includes('=') ? 2 : 1;
  }
  return args.slice(index);
}

function isXcodeTestAction(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === 'test' || normalized === 'test-without-building';
}

function isTestTask(value: string): boolean {
  const task = value.split(':').pop() ?? value;
  return (
    /^(?:check|test)(?:$|[-_A-Z])/.test(task) ||
    /(?:Android|E2e|Integration|Ui|Unit)Test(?:$|[-_A-Z])/.test(task)
  );
}

function isBuildTask(value: string): boolean {
  const task = value.split(':').pop() ?? value;
  return /^(?:assemble|build|bundle|compile)(?:$|[-_A-Z])/.test(task);
}

function parseCommand(value: string): ParsedCommand | null {
  const words = shellWords(value);
  let index = 0;
  while (isEnvironmentAssignment(words[index])) {
    index += 1;
  }
  const wrapper = normalizeExecutable(words[index] ?? '');
  if (wrapper === 'env') {
    index += 1;
    while (words[index]?.startsWith('-') || isEnvironmentAssignment(words[index])) {
      index += 1;
    }
  } else if (['command', 'nohup', 'sudo', 'time', 'xcrun'].includes(wrapper)) {
    if (words[index + 1] && !words[index + 1]?.startsWith('-')) {
      index += 1;
    }
  }
  const executable = normalizeExecutable(words[index] ?? '');
  return executable ? { executable, args: words.slice(index + 1) } : null;
}

function isEnvironmentAssignment(value: string | undefined): boolean {
  return value ? /^[A-Za-z_][A-Za-z0-9_]*=/.test(value) : false;
}

function normalizeExecutable(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return basename.replace(/\.(?:bat|cmd|exe)$/i, '');
}

function shellWords(value: string): string[] {
  const words: string[] = [];
  let previousEnd = 0;
  // Classify only the first simple command; later commands and echoed names must not change it.
  for (const match of value.matchAll(SHELL_WORD_PATTERN)) {
    const start = match.index ?? 0;
    if (SHELL_OPERATOR_PATTERN.test(value.slice(previousEnd, start))) {
      break;
    }
    words.push(decodeShellWord(match[0]));
    previousEnd = start + match[0].length;
  }
  return words;
}

function decodeShellWord(value: string): string {
  return value.replace(
    /"((?:\\.|[^"])*)"|'([^']*)'|\\([\\'" \t&|;])/g,
    (
      _match,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined,
      escaped: string | undefined,
    ) => {
      if (doubleQuoted !== undefined) {
        return doubleQuoted.replace(/\\([\\'" $`])/g, '$1');
      }
      return singleQuoted ?? escaped ?? _match;
    },
  );
}
