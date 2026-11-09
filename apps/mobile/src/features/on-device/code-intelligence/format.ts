import { format } from 'prettier/standalone';
import * as babel from 'prettier/plugins/babel';
import * as estree from 'prettier/plugins/estree';
import * as typescript from 'prettier/plugins/typescript';
import { OnDeviceNativeError } from '../native/services.errors';
import { LocalToolInputError } from '../runtime/toolArguments';
import {
  CODE_LIMITS,
  codeOperation,
  codePath,
  isScript,
  LocalCodeError,
  readCodeFile,
} from './workspace';
import type { CodeWorkspacePort } from './workspace';

function checkFormattedSize(content: string): void {
  let bytes = 0;
  for (const character of content) {
    const point = character.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes > CODE_LIMITS.fileBytes) {
      throw new LocalCodeError('CODE_BUDGET', 'Formatted output exceeds the 64 KiB UTF-8 limit.');
    }
  }
}

export async function formatCodeFile(
  native: CodeWorkspacePort,
  workspace: string,
  path: string,
  signal?: AbortSignal,
  observedRevision?: string,
): Promise<object> {
  codePath(path);
  if (!isScript(path) && !path.endsWith('.json')) {
    throw new LocalToolInputError(
      'Formatting supports only JS/JSX/TS/TSX/mjs/cjs/mts/cts and JSON.',
    );
  }
  const operation = codeOperation(signal);
  const file = await readCodeFile(native, workspace, path, operation);
  if (observedRevision !== undefined && file.revision !== observedRevision) {
    throw new OnDeviceNativeError(
      'FILE_REVISION_CONFLICT',
      'The file changed. Read it again before formatting.',
    );
  }
  let content: string;
  try {
    content = await format(file.content, {
      filepath: path,
      parser: path.endsWith('.json') ? 'json' : /\.[cm]?tsx?$/u.test(path) ? 'typescript' : 'babel',
      plugins: [babel, estree, typescript],
      embeddedLanguageFormatting: 'off',
      endOfLine: 'lf',
    });
  } catch {
    throw new LocalCodeError(
      'CODE_FORMAT_PARSE',
      'Prettier could not parse this file. Fix its syntax before formatting.',
    );
  }
  await operation.yield();
  checkFormattedSize(content);
  if (content === file.content) {
    return { path, revision: file.revision, changed: false };
  }
  operation.check();
  const revision = await native.writeWorkspaceFile(workspace, path, content, file.revision);
  return { path, revision, changed: true };
}
