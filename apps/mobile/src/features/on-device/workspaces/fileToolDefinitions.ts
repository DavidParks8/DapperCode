import { toolDefinition as definition } from '../runtime/toolDefinition';

// Keep generation grammars structural; the dispatcher and native boundary enforce all bounds.
const path = { type: 'string' } as const;
const revision = { type: ['string', 'null'] } as const;

export const FILE_TOOL_DEFINITIONS = [
  definition(
    'list_directory',
    'List a workspace directory. Use an empty path for the root. Truncation is reported.',
    {
      path: { type: 'string' },
      limit: { type: 'integer' },
    },
    [],
  ),
  definition(
    'read_file',
    'Read a UTF-8 file chunk. Returns JSON with path, content, revision, and nextOffset. Offsets and limits are UTF-8 bytes.',
    {
      path,
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    ['path'],
  ),
  definition(
    'write_file',
    'Create or replace UTF-8 text, at most 4 MiB. Replacing a file requires its last read revision.',
    { path, content: { type: 'string' }, expected_revision: revision },
    ['path', 'content'],
  ),
  definition(
    'edit_file',
    'Replace exactly one literal occurrence in a UTF-8 file. Requires the last read revision.',
    {
      path,
      old_text: { type: 'string' },
      new_text: { type: 'string' },
      expected_revision: { type: 'string' },
    },
    ['path', 'old_text', 'new_text', 'expected_revision'],
  ),
  definition(
    'rename_path',
    'Rename a workspace path without overwriting another path. Files require their last read revision.',
    { path, destination: path, expected_revision: revision },
    ['path', 'destination'],
  ),
  definition(
    'delete_path',
    'Remove a workspace path. Files require their last read revision. Repository roots and Git metadata are protected.',
    { path, expected_revision: revision },
    ['path'],
  ),
  definition(
    'search_files',
    'Find literal single-line text. Results report truncation, excluded files, and resource budgets.',
    { query: { type: 'string' } },
    ['query'],
  ),
];

export type FileToolName = (typeof FILE_TOOL_DEFINITIONS)[number]['function']['name'];
