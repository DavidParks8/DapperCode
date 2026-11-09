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
    'Search UTF-8 lines (literal by default). regex enables ICU regex with a time budget. path scopes a directory; include is a root-relative glob (*, **, ?); file_type is an extension without a dot. case_sensitive defaults true. offset/limit page matching lines (default 20, max 100). Results include line numbers, clipped previews, exclusions, budgets and truncation.',
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
    'Discover files by root-relative glob (*, **, ?). pattern defaults to **/* (all files). path scopes a directory; file_type filters extension. offset/limit page results (offset max 10000; limit default 20, max 100). Git-ignored files and links are excluded. Results report budgets and truncation; only nextOffset permits paging.',
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
    'Coordinated UTF-8 add/update/delete/move, max 32 files and 4 MiB patch. Read every existing source in this turn first; revisions come from the runtime, never the model. Format: *** Begin Patch; *** Add File: path then +lines; *** Update File: path optionally *** Move to: destination then standard @@ -old,count +new,count @@ hunks with space context, -removed, +added lines; *** Delete File: path; *** End Patch. Use \\ No newline at end of file after a line lacking a newline. All paths/hunks/revisions validate before publication. Destinations must not exist; duplicate/ancestor paths reject.',
    { patch: { type: 'string' } },
    ['patch'],
    { kind: 'edit', approval: null },
  ),
];

export type FileToolName = (typeof FILE_TOOL_DEFINITIONS)[number]['definition']['function']['name'];
