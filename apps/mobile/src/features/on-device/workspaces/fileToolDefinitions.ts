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
    `Read a UTF-8 file chunk. offset/limit are bytes (limit default ${READ_FILE_DEFAULT_BYTES}, max ${READ_FILE_MAX_BYTES}); follow nextOffset for more.`,
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
    'Create or replace a UTF-8 file (max 4 MiB); read an existing file first. JS/TS/JSON are then auto-formatted; a formatting error does not undo the write.',
    { path, content: { type: 'string' } },
    ['path', 'content'],
    { kind: 'edit', approval: null },
  ),
  definition(
    'edit_file',
    'Replace exactly one literal occurrence of old_text in a UTF-8 file read or written in this turn. JS/TS/JSON are then auto-formatted; a formatting error does not undo the edit.',
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
    'Move a path to a destination that must not exist. Read or write a source file in this turn first; never create or read the destination. No Git staging needed.',
    { path, destination: path },
    ['path', 'destination'],
    { kind: 'move', approval: null },
  ),
  definition(
    'delete_path',
    'Remove a workspace path; read or write a file in this turn first. Repository roots and Git metadata are protected.',
    { path },
    ['path'],
    { kind: 'delete', approval: null },
  ),
  definition(
    'search_files',
    'Search file lines for literal text, or ICU regex if regex. Optional path directory, include root-relative glob, file_type extension without a dot; case-sensitive by default. offset/limit page matches (limit default 20, max 100).',
    {
      query: { type: 'string' },
      path,
      include: path,
      file_type: path,
      regex: { type: 'boolean' },
      case_sensitive: { type: 'boolean' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    ['query'],
    { kind: 'search', approval: null },
  ),
  definition(
    'glob_files',
    'Find files by root-relative glob (*, **, ?); pattern defaults to **/*. path scopes a directory; file_type filters extension. offset/limit page results (limit default 20, max 100); page only with nextOffset. Git-ignored files are excluded.',
    {
      pattern: path,
      path,
      file_type: path,
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    [],
    { kind: 'search', approval: null },
  ),
  definition(
    'apply_patch',
    'Atomically add/update/delete/move up to 32 UTF-8 files; read every existing source in this turn first. Format: *** Begin Patch; *** Add File: path then +lines; *** Update File: path, optional *** Move to: destination, then @@ -old,count +new,count @@ hunks of space-context, -removed and +added lines; *** Delete File: path; *** End Patch. Destinations must not exist.',
    { patch: { type: 'string' } },
    ['patch'],
    { kind: 'edit', approval: null },
  ),
];

export type FileToolName = (typeof FILE_TOOL_DEFINITIONS)[number]['definition']['function']['name'];
