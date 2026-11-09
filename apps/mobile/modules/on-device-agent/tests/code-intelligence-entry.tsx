import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { getOnDeviceNativeServices } from '../../../src/features/on-device/native/services';
import { localToolExecutor } from '../../../src/features/on-device/runtime/localTools';
import { isRecord } from '../../../src/shared/records';

const outcome = new File(Paths.document, 'native-code-intelligence-result.json');
const checks: Record<string, boolean> = {};

function check(condition: unknown, name: string, detail = ''): asserts condition {
  if (!condition) {
    throw new Error(`${name}${detail ? `: ${detail}` : ''}`);
  }
  checks[name] = true;
  outcome.write(JSON.stringify({ status: 'running', checks }));
}

async function exerciseNativeCodeTools() {
  check('HermesInternal' in globalThis, 'realHermesRuntime');
  const native = getOnDeviceNativeServices();
  const workspace = await native.createWorkspace('Native code intelligence');
  const execute = localToolExecutor(
    native,
    () => null,
    async () => null,
    () => {
      throw new Error('Code tools must stay offline.');
    },
  );
  const signal = new AbortController().signal;
  const read = (path: string) => native.readWorkspaceFile(workspace.id, path, 0, 65_536);
  try {
    const created = await execute(
      workspace.id,
      'write_file',
      { path: 'math.ts', content: 'export const double=(n:number)=>n*2' },
      signal,
    );
    check(
      isRecord(created) &&
        isRecord(created['formatting']) &&
        created['formatting']['status'] === 'formatted',
      'writeAutomaticallyFormats',
      JSON.stringify(created),
    );
    const math = await read('math.ts');
    check(
      math.content === 'export const double = (n: number) => n * 2;\n' &&
        math.revision === created['revision'],
      'nativePostFormatRevision',
    );
    await execute(
      workspace.id,
      'write_file',
      { path: 'main.ts', content: 'import {double} from "./math";\nconst n=double("wrong")' },
      signal,
    );
    const diagnostics = await execute(
      workspace.id,
      'code_diagnostics',
      { path: 'main.ts' },
      signal,
    );
    check(
      isRecord(diagnostics) &&
        Array.isArray(diagnostics['results']) &&
        diagnostics['results'].some((item: unknown) => isRecord(item) && item['code'] === 2345),
      'realHermesCompilerDiagnostics',
    );
    const definition = await execute(
      workspace.id,
      'code_definitions',
      { path: 'main.ts', line: 2, column: 12 },
      signal,
    );
    check(
      isRecord(definition) &&
        Array.isArray(definition['results']) &&
        definition['results'].some((item: unknown) => isRecord(item) && item['path'] === 'math.ts'),
      'realHermesCrossFileDefinitions',
    );
    const references = await execute(
      workspace.id,
      'code_references',
      { path: 'math.ts', line: 1, column: 15 },
      signal,
    );
    check(
      isRecord(references) &&
        Array.isArray(references['results']) &&
        references['results'].length === 3,
      'realHermesCrossFileReferences',
    );
    const symbols = await execute(workspace.id, 'code_symbols', { path: 'math.ts' }, signal);
    check(
      isRecord(symbols) &&
        Array.isArray(symbols['results']) &&
        symbols['results'].some((item: unknown) => isRecord(item) && item['name'] === 'double'),
      'realHermesSymbols',
    );
    const edited = await execute(
      workspace.id,
      'edit_file',
      { path: 'main.ts', old_text: '"wrong"', new_text: '42' },
      signal,
    );
    check(
      isRecord(edited) &&
        isRecord(edited['formatting']) &&
        edited['formatting']['status'] === 'unchanged',
      'editAutomaticallyChecksFormatting',
    );
    const settled = await execute(workspace.id, 'code_diagnostics', { path: 'main.ts' }, signal);
    check(
      isRecord(settled) && Array.isArray(settled['results']) && settled['results'].length === 0,
      'freshDiagnosticsAfterEdit',
    );
    const broken = await execute(
      workspace.id,
      'write_file',
      { path: 'broken.ts', content: 'const = ;' },
      signal,
    );
    check(
      isRecord(broken) &&
        isRecord(broken['formatting']) &&
        broken['formatting']['code'] === 'CODE_FORMAT_PARSE',
      'formatParseFailureReportedSeparately',
    );
    check((await read('broken.ts')).content === 'const = ;', 'successfulEditSurvivesFormatFailure');
    await execute(
      workspace.id,
      'edit_file',
      { path: 'broken.ts', old_text: 'const = ;', new_text: 'export const fixed=1' },
      signal,
    );
    check(
      (await read('broken.ts')).content === 'export const fixed = 1;\n',
      'repairUsesRetainedEditRevision',
    );
    const json = await execute(
      workspace.id,
      'write_file',
      { path: 'data.json', content: '{"n":1}' },
      signal,
    );
    check(
      isRecord(json) &&
        isRecord(json['formatting']) &&
        json['formatting']['status'] === 'formatted' &&
        (await read('data.json')).content === '{ "n": 1 }\n',
      'realHermesJsonFormatter',
    );
    const large = `export const value="${'é'.repeat(20_000)}";\n`;
    await native.writeWorkspaceFile(workspace.id, 'large.ts', large, null);
    for (let index = 0; index < 300; index++) {
      await native.writeWorkspaceFile(workspace.id, `entry${index}.json`, '{}', null);
    }
    const listing = await native.listWorkspaceFiles(workspace.id, '', 512);
    const largeRead = await read('large.ts');
    check(
      listing.entries.length > 200 && !listing.truncated,
      'productionListingAccepts512AboveModelCap',
    );
    check(
      largeRead.totalBytes > 16_384 && largeRead.content === large && largeRead.nextOffset === null,
      'productionReadAccepts65536AboveModelCap',
    );
    const largeDiagnostics = await execute(
      workspace.id,
      'code_diagnostics',
      { path: 'large.ts' },
      signal,
    );
    check(
      isRecord(largeDiagnostics) &&
        Array.isArray(largeDiagnostics['results']) &&
        largeDiagnostics['results'].length === 0,
      'realCompilerUsesNativeBounds',
    );
    for (const [name, operation] of [
      ['invalidNativeListingRejected', () => native.listWorkspaceFiles(workspace.id, '', 1001)],
      [
        'invalidNativeReadRejected',
        () => native.readWorkspaceFile(workspace.id, 'large.ts', 0, 65_537),
      ],
    ] as const) {
      let rejected = false;
      try {
        await operation();
      } catch {
        rejected = true;
      }
      check(rejected, name);
    }
    const stale = await read('math.ts');
    await native.writeWorkspaceFile(
      workspace.id,
      'math.ts',
      'export const external=3',
      stale.revision,
    );
    let conflict = false;
    try {
      await execute(
        workspace.id,
        'edit_file',
        { path: 'math.ts', old_text: 'external', new_text: 'other' },
        signal,
      );
    } catch (error) {
      conflict = isRecord(error) && error['code'] === 'FILE_REVISION_CONFLICT';
    }
    check(
      conflict && (await read('math.ts')).content === 'export const external=3',
      'nativeConflictPreservesExternalEdit',
    );
    const stopped = new AbortController();
    stopped.abort();
    let cancelled = false;
    try {
      await execute(workspace.id, 'format_file', { path: 'math.ts' }, stopped.signal);
    } catch (error) {
      cancelled = isRecord(error) && error['code'] === 'CODE_CANCELLED';
    }
    check(
      cancelled && (await read('math.ts')).content === 'export const external=3',
      'stopFencesNativeFormattingWrite',
    );
  } finally {
    await native.deleteWorkspace(workspace.id);
  }
  check(
    !(await native.listWorkspaces()).some((item) => item.id === workspace.id),
    'ownedWorkspaceCleaned',
  );
}

function NativeCodeIntelligenceGate() {
  const [status, setStatus] = useState('running');
  useEffect(() => {
    void exerciseNativeCodeTools()
      .then(() => {
        outcome.write(JSON.stringify({ status: 'pass', checks }));
        setStatus('pass');
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        outcome.write(JSON.stringify({ status: 'fail', checks, error: message }));
        setStatus('fail');
      });
  }, []);
  return (
    <View>
      <Text>{status}</Text>
    </View>
  );
}

registerRootComponent(NativeCodeIntelligenceGate);
