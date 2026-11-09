import { toolDefinition } from '../runtime/toolDefinition';

const path = { type: 'string' } as const;
const position = { path, line: { type: 'integer' }, column: { type: 'integer' } } as const;
// Budget errors are explicit at runtime, so descriptions carry only what changes interpretation.
const scope = 'Local TypeScript service for JS/TS files (not an external LSP). ';

export const CODE_TOOL_DEFINITIONS = [
  toolDefinition(
    'code_diagnostics',
    scope +
      'Syntax/type diagnostics for one file: strict ES2022, relative workspace imports only, no tsconfig, package, Node or React types, max 64 files. Empty means no issues under these settings, not a full build.',
    { path },
    ['path'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'code_definitions',
    scope + 'Definitions of the symbol at 1-based line and UTF-16 column, across workspace files.',
    position,
    ['path', 'line', 'column'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'code_references',
    scope + 'References, including declarations, to the symbol at 1-based line and UTF-16 column.',
    position,
    ['path', 'line', 'column'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'code_symbols',
    scope + 'Declared symbols in one file with 1-based locations.',
    { path },
    ['path'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'format_file',
    'Format one JS/TS/JSON file with bundled Prettier defaults (max 64 KiB); write_file/edit_file already do this. Syntax errors reject without writing.',
    { path },
    ['path'],
    { kind: 'edit', approval: null },
  ),
];

export function isCodeTool(name: string): boolean {
  return CODE_TOOL_DEFINITIONS.some((tool) => tool.definition.function.name === name);
}
