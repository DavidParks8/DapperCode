import ts, { libraries } from './generated/compiler';
import type TS from 'typescript';
import { argumentsRecord, integer, LocalToolInputError, text } from '../runtime/toolArguments';
import { formatCodeFile } from './format';
import { boundedCodeResults, codeOperation, codePath, codeSnapshot, isScript } from './workspace';
import type { CodeWorkspacePort } from './workspace';

const ROOT = '/workspace/';
const LIB = '/lib/';
const SETTINGS: TS.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  allowJs: true,
  checkJs: true,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  lib: ['lib.es2022.d.ts'],
  types: [],
};

function positionFor(source: TS.SourceFile, args: Record<string, unknown>): number {
  if (args['line'] === undefined || args['column'] === undefined) {
    throw new LocalToolInputError('Both line and column are required.');
  }
  const line = integer(args, 'line', 1, 1, source.getLineStarts().length);
  const column = integer(args, 'column', 1, 1, 65_537);
  const start = source.getLineStarts()[line - 1];
  const end = source.getLineStarts()[line] ?? source.text.length + 1;
  if (start === undefined || start + column - 1 >= end) {
    throw new LocalToolInputError('The column is beyond the requested line.');
  }
  return source.getPositionOfLineAndCharacter(line - 1, column - 1);
}

export async function executeCodeTool(
  workspace: string,
  name: string,
  input: unknown,
  native: CodeWorkspacePort,
  signal?: AbortSignal,
  observedRevision?: string,
): Promise<unknown> {
  const positioned = name === 'code_definitions' || name === 'code_references';
  const args = argumentsRecord(input, positioned ? ['path', 'line', 'column'] : ['path']);
  const path = codePath(text(args, 'path', 256));
  if (name === 'format_file') {
    return formatCodeFile(native, workspace, path, signal, observedRevision);
  }
  if (!['code_diagnostics', 'code_definitions', 'code_references', 'code_symbols'].includes(name)) {
    throw new LocalToolInputError('This local code tool is not available.');
  }
  if (!isScript(path)) {
    throw new LocalToolInputError(
      'Code intelligence supports only JavaScript and TypeScript files.',
    );
  }
  const operation = codeOperation(signal);
  operation.check();
  const files = await codeSnapshot(native, workspace, operation);
  const target = files.get(path);
  if (!target) {
    throw new LocalToolInputError(
      'This file is missing, excluded, or not a regular workspace source file.',
    );
  }
  const readFile = (fileName: string) =>
    fileName.startsWith(ROOT)
      ? files.get(fileName.slice(ROOT.length))?.content
      : fileName.startsWith(LIB)
        ? libraries[fileName.slice(LIB.length)]
        : undefined;
  const moduleHost: TS.ModuleResolutionHost = {
    fileExists: (fileName) => readFile(fileName) !== undefined,
    readFile,
  };
  const host: TS.LanguageServiceHost = {
    ...moduleHost,
    getCompilationSettings: () => SETTINGS,
    getScriptFileNames: () => [...files.keys()].map((file) => ROOT + file),
    getScriptVersion: (fileName) => files.get(fileName.slice(ROOT.length))?.revision ?? 'bundled',
    getScriptSnapshot: (fileName) => {
      operation.check();
      const content = readFile(fileName);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => ROOT.slice(0, -1),
    getDefaultLibFileName: () => LIB + 'lib.es2022.d.ts',
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    getCancellationToken: () => ({
      isCancellationRequested: () => {
        operation.check();
        return false;
      },
      throwIfCancellationRequested: operation.check,
    }),
    resolveModuleNames: (modules, containingFile) =>
      modules.map((moduleName) => {
        operation.check();
        if (!moduleName.startsWith('./') && !moduleName.startsWith('../')) {
          return undefined;
        }
        const resolved = ts.resolveModuleName(
          moduleName,
          containingFile,
          SETTINGS,
          moduleHost,
        ).resolvedModule;
        return resolved?.resolvedFileName.startsWith(ROOT) ? resolved : undefined;
      }),
  };
  const service = ts.createLanguageService(host);
  const fileName = ROOT + path;
  try {
    await operation.yield();
    const program = service.getProgram();
    const source = program?.getSourceFile(fileName);
    if (!source) {
      throw new LocalToolInputError('The compiler could not load the requested source file.');
    }
    const location = (target: string, span: TS.TextSpan) => {
      if (!target.startsWith(ROOT)) {
        return null;
      }
      const file = program?.getSourceFile(target);
      const snapshot = files.get(target.slice(ROOT.length));
      if (!file || !snapshot) {
        return null;
      }
      const start = file.getLineAndCharacterOfPosition(span.start);
      const end = file.getLineAndCharacterOfPosition(span.start + span.length);
      return {
        path: target.slice(ROOT.length),
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
        revision: snapshot.revision,
      };
    };
    let results: unknown[];
    if (name === 'code_diagnostics') {
      results = [
        ...service.getSyntacticDiagnostics(fileName),
        ...service.getSemanticDiagnostics(fileName),
      ].map((diagnostic) => ({
        ...location(fileName, { start: diagnostic.start ?? 0, length: diagnostic.length ?? 0 }),
        code: diagnostic.code,
        severity: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n').slice(0, 400),
      }));
    } else if (name === 'code_symbols') {
      results = [];
      const visit = (items: TS.NavigationTree[]) => {
        for (const item of items) {
          operation.check();
          const span = item.nameSpan ?? item.spans[0];
          if (span) {
            results.push({
              name: item.text.slice(0, 160),
              kind: item.kind,
              ...location(fileName, span),
            });
          }
          if (item.childItems) {
            visit(item.childItems);
          }
        }
      };
      visit(service.getNavigationTree(fileName).childItems ?? []);
    } else {
      const offset = positionFor(source, args);
      const spans =
        name === 'code_definitions'
          ? service.getDefinitionAtPosition(fileName, offset)
          : service.getReferencesAtPosition(fileName, offset);
      results = (spans ?? [])
        .map((span) => location(span.fileName, span.textSpan))
        .filter((item) => item !== null);
    }
    await operation.yield();
    return boundedCodeResults(results, {
      path,
      revision: target.revision,
      files: files.size,
      engine: 'typescript-language-service',
    });
  } finally {
    service.dispose();
  }
}
