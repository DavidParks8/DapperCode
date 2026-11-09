import { toolDefinition as definition } from '../runtime/toolDefinition';

// Small model contexts hold only a few kilobytes of tool output per turn, so reads stay chunked.
export const READ_FILE_DEFAULT_BYTES = 3072;
export const READ_FILE_MAX_BYTES = 16_384;
export const LIST_DIRECTORY_DEFAULT_LIMIT = 64;
export const LIST_DIRECTORY_MAX_LIMIT = 200;

// Keep generation grammars structural; the dispatcher and native boundary enforce all bounds.
const path = { type: 'string' } as const;

export const FILE_TOOL_DEFINITIONS = [
  definition(
    'list_directory',
    `List a workspace directory. Use an empty path for the root. limit defaults to ${LIST_DIRECTORY_DEFAULT_LIMIT} (max ${LIST_DIRECTORY_MAX_LIMIT}).`,
    {
      path: { type: 'string' },
      limit: { type: 'integer' },
    },
    [],
    { kind: 'read', approval: null },
  ),
  definition(
    'read_file',
    `Read a UTF-8 file chunk. Returns path, content, revision, and nextOffset. offset/limit are bytes; limit defaults to ${READ_FILE_DEFAULT_BYTES} (max ${READ_FILE_MAX_BYTES}).`,
    {
      path,
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    ['path'],
    { kind: 'read', approval: null },
  ),
  definition(
    'write_file',
    'Create or replace UTF-8 text, at most 4 MiB. Read an existing file first. The runtime checks its observed version so external changes cannot be overwritten. JS/TS/JSON are automatically formatted afterward; the result reports formatting status/errors separately from the successful edit.',
    { path, content: { type: 'string' } },
    ['path', 'content'],
    { kind: 'edit', approval: null },
  ),
  definition(
    'edit_file',
    'Replace exactly one literal occurrence in a UTF-8 file previously read or written in this turn. The runtime checks and updates its observed version. JS/TS/JSON are automatically formatted afterward; the result reports formatting status/errors separately from the successful edit.',
    {
      path,
      old_text: { type: 'string' },
      new_text: { type: 'string' },
    },
    ['path', 'old_text', 'new_text'],
    { kind: 'edit', approval: null },
  ),
  definition(
    'rename_path',
    'Move an existing source path to a destination that must not exist. Read or write a source file in this turn first; its version is checked by the runtime. Never create or read the destination first. Git staging is not needed.',
    { path, destination: path },
    ['path', 'destination'],
    { kind: 'move', approval: null },
  ),
  definition(
    'delete_path',
    'Remove a workspace path. Read or write a file in this turn first; the runtime checks its observed version. Repository roots and Git metadata are protected.',
    { path },
    ['path'],
    { kind: 'delete', approval: null },
  ),
  definition(
    'search_files',
    'Find literal single-line text. Results report truncation, excluded files, and resource budgets.',
    { query: { type: 'string' } },
    ['query'],
    { kind: 'search', approval: null },
  ),
];

export type FileToolName = (typeof FILE_TOOL_DEFINITIONS)[number]['definition']['function']['name'];
