import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { isRecord } from '../../../src/shared/records';
import { getOnDeviceNativeServices } from '../../../src/features/on-device/native/services';
import { localModelDefinition } from '../../../src/features/on-device/models/catalog';
import { ModelDownloadController } from '../../../src/features/on-device/models/downloads';
import {
  expoModelTransfers,
  modelResumeStorage,
} from '../../../src/features/on-device/models/expoDownloads';
import type { ModelDownloadSnapshot } from '../../../src/features/on-device/models/downloads';

const checks: Record<string, boolean> = {};
const outcome = new File(Paths.document, 'native-download-result.json');

function check(condition: unknown, label: string): asserts condition {
  if (!condition) {
    throw new Error(label);
  }
  checks[label] = true;
}

async function run() {
  const raw: unknown = JSON.parse(await new File(Paths.document, 'download-fixture.json').text());
  check(
    isRecord(raw) &&
      typeof raw['url'] === 'string' &&
      typeof raw['sha256'] === 'string' &&
      typeof raw['bytes'] === 'number',
    'fixtureConfiguration',
  );
  const base = localModelDefinition('qwen3-1.7b-q4-k-m');
  const model = {
    ...base,
    id: 'native-download-fixture',
    downloadUrl: raw['url'],
    sha256: raw['sha256'],
    bytes: raw['bytes'],
  };
  const native = getOnDeviceNativeServices();
  const events: ModelDownloadSnapshot[] = [];
  const control: { pause: Promise<void> | null } = { pause: null };
  const first = new ModelDownloadController(
    [model],
    native,
    expoModelTransfers,
    modelResumeStorage,
    (state) => {
      events.push(state);
      if (
        state.phase === 'downloading' &&
        state.bytesWritten >= 64 * 1024 &&
        state.bytesWritten < model.bytes &&
        !control.pause
      ) {
        control.pause = first.pause();
      }
    },
  );
  const paused = await first.download(model.id);
  check(control.pause !== null, 'pauseRequested');
  await control.pause;
  check(paused.phase === 'paused' && paused.canResume && paused.bytesWritten > 0, 'nativePause');
  check((await native.getDownloadedModelFile(model.id)) === null, 'pausedNotReady');
  const second = new ModelDownloadController(
    [model],
    native,
    expoModelTransfers,
    modelResumeStorage,
    (state) => events.push(state),
  );
  const restored = await second.inspect(model.id);
  check(restored.phase === 'paused' && restored.canResume, 'restoredCheckpoint');
  const ready = await second.resume(model.id);
  check(
    ready.phase === 'ready' &&
      ready.file?.sha256 === model.sha256 &&
      ready.file.bytes === model.bytes,
    'nativeResumeAndVerification',
  );
  check(
    events.some((state) => state.phase === 'verifying'),
    'verificationBeforeReady',
  );
  const cold = new ModelDownloadController(
    [model],
    native,
    expoModelTransfers,
    modelResumeStorage,
    () => {},
  );
  check((await cold.inspect(model.id)).phase === 'ready', 'coldReadyWithoutNetwork');
  const paths = await native.getModelFilePaths(model.id);
  check(!new File(paths.resumeUri).exists, 'resumeMetadataRemoved');
  const corrupted = { ...model, id: 'native-download-bad-hash', sha256: '0'.repeat(64) };
  const bad = new ModelDownloadController(
    [corrupted],
    native,
    expoModelTransfers,
    modelResumeStorage,
    () => {},
  );
  let rejected = false;
  try {
    await bad.download(corrupted.id);
  } catch (error) {
    rejected = error instanceof Error && error.message.includes('checksum');
  }
  check(rejected && bad.snapshot(corrupted.id).phase === 'error', 'checksumFailureVisible');
  check((await native.getDownloadedModelFile(corrupted.id)) === null, 'checksumFailureNotReady');
  await cold.remove(model.id);
  check((await cold.inspect(model.id)).phase === 'not_downloaded', 'nativeRemoval');
}

let started = false;

function DownloadGate() {
  const [status, setStatus] = useState('running');
  useEffect(() => {
    if (started) {
      return;
    }
    started = true;
    void run().then(
      () => {
        outcome.write(JSON.stringify({ status: 'pass', checks }));
        setStatus('pass');
      },
      (error: unknown) => {
        outcome.write(
          JSON.stringify({
            status: 'fail',
            checks,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        setStatus('fail');
      },
    );
  }, []);
  return <Text>Native model transfers: {status}</Text>;
}

registerRootComponent(DownloadGate);
