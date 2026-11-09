import { isRecord } from '@shared/records';
import type * as Formatting from './format';
import type { CodeWorkspacePort } from './workspace';
import { isFormattable, LocalCodeError } from './workspace';

export interface LocalCompletedFileEdit {
  path: string;
  revision: string;
}

export interface LocalFormattedFileEdit extends LocalCompletedFileEdit {
  formatting: {
    status: 'formatted' | 'unchanged' | 'unsupported' | 'failed' | 'cancelled';
    code?: string;
    message?: string;
    location?: { path: string; line: number; column: number };
  };
}

/** Only call after a native edit succeeds. A formatting failure must not erase that success. */
export async function formatAfterFileEdit(
  native: CodeWorkspacePort,
  workspace: string,
  edit: LocalCompletedFileEdit,
  signal?: AbortSignal,
): Promise<LocalFormattedFileEdit> {
  if (!isFormattable(edit.path)) {
    return {
      ...edit,
      formatting: {
        status: 'unsupported',
        message: 'Automatic formatting supports JS/TS and JSON only.',
      },
    };
  }
  try {
    // Initialization failures are formatting failures too, never failures of the completed edit.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { formatCodeFile } = require('./format') as typeof Formatting;
    const formatted = await formatCodeFile(native, workspace, edit.path, signal, edit.revision);
    return {
      path: edit.path,
      revision: formatted.revision,
      formatting: {
        status: formatted.changed ? 'formatted' : 'unchanged',
        ...(formatted.changed
          ? {
              message:
                'Formatting changed the content; re-read before another exact-text edit or patch.',
            }
          : {}),
      },
    };
  } catch (error) {
    const record = isRecord(error) ? error : null;
    const code =
      typeof record?.['code'] === 'string' ? record['code'].slice(0, 80) : 'CODE_FORMAT_FAILED';
    const message =
      typeof record?.['message'] === 'string'
        ? record['message'].slice(0, 400)
        : typeof error === 'string'
          ? error.slice(0, 400)
          : 'Automatic formatting failed.';
    return {
      ...edit,
      formatting: {
        status: code === 'CODE_CANCELLED' ? 'cancelled' : 'failed',
        code,
        message,
        ...(error instanceof LocalCodeError && error.location ? { location: error.location } : {}),
      },
    };
  }
}
