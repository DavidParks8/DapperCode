import { toolDefinition } from '../runtime/toolDefinition';

const path = { type: 'string' } as const;
const position = { path, line: { type: 'integer' }, column: { type: 'integer' } } as const;
const scope =
  'Local TypeScript LanguageService, not an external LSP. JS/JSX/TS/TSX, including mjs/cjs/mts/cts. ' +
  'ES2022, strict checks, relative workspace imports only; no tsconfig, installed package types, or Node/React ambient types. ' +
  'Budget: 64 files, 64 KiB/file, 512 KiB/project, 512 directory entries, 5 seconds cooperative; results capped at 40/8192 characters. ';

export const CODE_TOOL_DEFINITIONS = [
  toolDefinition(
    'code_diagnostics',
    scope +
      'Get syntax and type diagnostics for one file. Empty results mean no issues under these settings, not a full project build.',
    { path },
    ['path'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'code_definitions',
    scope +
      'Resolve the symbol at 1-based line/column to definitions across workspace files. Columns count UTF-16 code units.',
    position,
    ['path', 'line', 'column'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'code_references',
    scope +
      'Find real symbol references across workspace files at 1-based line/UTF-16 column; includes declarations.',
    position,
    ['path', 'line', 'column'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'code_symbols',
    scope + 'List declared symbols in one file with 1-based source locations.',
    { path },
    ['path'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'format_file',
    'Format one JS/JSX/TS/TSX/mjs/cjs/mts/cts/JSON file using bundled Prettier, offline. write_file/edit_file already format these languages automatically and report formatting status; use this tool to format an existing file explicitly. Fixed defaults, no workspace config/plugins. Maximum 64 KiB input; syntax errors reject without writes. Revision-checked; unchanged files are not rewritten.',
    { path },
    ['path'],
    { kind: 'edit', approval: null },
  ),
];

export function isCodeTool(name: string): boolean {
  return CODE_TOOL_DEFINITIONS.some((tool) => tool.definition.function.name === name);
}
