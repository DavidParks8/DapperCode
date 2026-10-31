import { registerRootComponent } from 'expo';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { AppState, Text } from 'react-native';

import { isRecord } from '../../../src/shared/records';
import { getOnDeviceNativeServices } from '../../../src/features/on-device/native/services';
import { localModelDefinition } from '../../../src/features/on-device/models/catalog';
import {
  ModelDownloadController,
  type ModelDownloadSnapshot,
} from '../../../src/features/on-device/models/downloads';
import type { LocalModelDefinition } from '../../../src/features/on-device/models/types';

const checks: Record<string, boolean> = {};
const marker = new File(Paths.document, 'native-download-phase.json');
const phaseOutcome = new File(Paths.document, 'native-download-phase-a.json');
const outcome = new File(Paths.document, 'native-download-result.json');

function check(condition: unknown, label: string): asserts condition {
  if (!condition) {
    throw new Error(label);
  }
  checks[label] = true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label: string, predicate: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${label}`);
    }
    await sleep(100);
  }
}

async function fixture(): Promise<LocalModelDefinition[]> {
  const raw: unknown = JSON.parse(await new File(Paths.document, 'download-fixture.json').text());
  if (
    !isRecord(raw) ||
    typeof raw['url'] !== 'string' ||
    typeof raw['secondUrl'] !== 'string' ||
    typeof raw['sha256'] !== 'string' ||
    typeof raw['bytes'] !== 'number'
  ) {
    throw new Error('fixtureConfiguration');
  }
  const base = localModelDefinition('qwen3-1.7b-q4-k-m');
  const model = { ...base, sha256: raw['sha256'], bytes: raw['bytes'] };
  return [
    { ...model, id: 'native-download-first', downloadUrl: raw['url'] },
    { ...model, id: 'native-download-second', downloadUrl: raw['secondUrl'] },
    { ...model, id: 'native-download-bad-hash', downloadUrl: raw['url'], sha256: '0'.repeat(64) },
    { ...model, id: 'native-download-pause-failure', downloadUrl: raw['url'] },
  ];
}

function controller(models: LocalModelDefinition[], events: ModelDownloadSnapshot[] = []) {
  return new ModelDownloadController(models, getOnDeviceNativeServices(), (snapshot) => {
    if (snapshot) {
      events.push(snapshot);
    }
  });
}

/** First launch: concurrent transfers, independent pause/resume, then the app is terminated. */
async function beforeTermination(models: LocalModelDefinition[]) {
  const [first, second] = models as [LocalModelDefinition, LocalModelDefinition];
  const native = getOnDeviceNativeServices();
  const downloads = controller(models);
  await Promise.all(models.map((model) => downloads.inspect(model.id)));
  const started = await downloads.download(first.id);
  check(
    started.phase === 'downloading' && (await native.getDownloadedModelFile(first.id)) === null,
    'downloadResolvesWhenStarted',
  );
  check((await downloads.download(second.id)).phase === 'downloading', 'secondStartsInParallel');
  await until(
    'both transfers progress',
    () =>
      downloads.snapshot(first.id).bytesWritten >= 64 * 1024 &&
      downloads.snapshot(second.id).bytesWritten >= 64 * 1024,
  );
  check(
    native.getModelDownload(first.id).state === 'running' &&
      native.getModelDownload(second.id).state === 'running',
    'concurrentNativeTransfers',
  );
  const paused = await downloads.pause(first.id);
  check(paused.phase === 'paused' && paused.canResume && paused.bytesWritten > 0, 'nativePause');
  check((await native.getDownloadedModelFile(first.id)) === null, 'pausedNotReady');
  const secondBefore = downloads.snapshot(second.id).bytesWritten;
  await sleep(1_500);
  check(
    downloads.snapshot(second.id).bytesWritten > secondBefore &&
      downloads.snapshot(first.id).bytesWritten === paused.bytesWritten &&
      downloads.snapshot(second.id).phase === 'downloading',
    'pausingOneLeavesOtherRunning',
  );
  const restored = controller(models);
  const checkpoint = await restored.inspect(first.id);
  restored.dispose();
  check(checkpoint.phase === 'paused' && checkpoint.canResume, 'restoredCheckpoint');
  check((await downloads.resume(first.id)).phase === 'downloading', 'nativeResume');
  check(
    downloads.snapshot(second.id).bytesPerSecond !== null &&
      downloads.snapshot(second.id).etaSeconds !== null,
    'speedAndEta',
  );
  check(
    downloads.snapshot(first.id).bytesWritten < first.bytes &&
      downloads.snapshot(second.id).bytesWritten < second.bytes,
    'transfersStillRunningAtTermination',
  );
  marker.write(JSON.stringify({ phase: 'terminate' }));
  phaseOutcome.write(JSON.stringify({ status: 'terminate', checks }));
}

/** A pause whose checkpoint cannot be written must not leave a phantom running transfer. */
async function pauseFailureReleasesTransfer(
  downloads: ModelDownloadController,
  model: LocalModelDefinition,
) {
  const native = getOnDeviceNativeServices();
  await downloads.download(model.id);
  await until(
    'pause-failure transfer progresses',
    () => downloads.snapshot(model.id).bytesWritten >= 64 * 1024,
  );
  const partial = (await native.getModelFilePaths(model.id)).partialUri;
  const blocker = new Directory(partial.replace(/partial\.gguf$/, 'resume.data'));
  blocker.create();
  new File(blocker, 'occupied').write('x');
  const failed = await downloads.pause(model.id);
  check(
    failed.phase === 'error' &&
      failed.error !== null &&
      native.getModelDownload(model.id).state !== 'running',
    'pauseFailureReleasesTransfer',
  );
  check((await downloads.download(model.id)).phase === 'downloading', 'pauseFailureCanRestart');
  check((await downloads.cancel(model.id)).phase === 'not_downloaded', 'pauseFailureCancelled');
}

/** Second launch: the background session re-attaches or delivers what finished while closed. */
async function afterRelaunch(models: LocalModelDefinition[]) {
  const [first, second, bad, pauseFailure] = models as [
    LocalModelDefinition,
    LocalModelDefinition,
    LocalModelDefinition,
    LocalModelDefinition,
  ];
  const native = getOnDeviceNativeServices();
  // iOS may relaunch the app in the background to deliver finished transfers; work starts once a
  // person opens it, because transfers created in the background are discretionary.
  await until('app is active', () => AppState.currentState === 'active', 300_000);
  const events: ModelDownloadSnapshot[] = [];
  const downloads = controller(models, events);
  for (const model of [first, second]) {
    const state = await downloads.inspect(model.id);
    check(
      state.phase === 'downloading' || (state.phase === 'paused' && state.verificationPending),
      `reattached:${model.id}`,
    );
  }
  await downloads.resumeLifecyclePaused();
  for (const model of [first, second]) {
    const ready = await downloads.settled(model.id);
    check(
      ready.phase === 'ready' &&
        ready.file?.sha256 === model.sha256 &&
        ready.file.bytes === model.bytes,
      `survivedTermination:${model.id}`,
    );
  }
  check(
    events.some((state) => state.phase === 'verifying'),
    'verificationBeforeReady',
  );
  const cold = controller(models);
  check((await cold.inspect(first.id)).phase === 'ready', 'coldReadyWithoutNetwork');
  check(native.getModelDownload(first.id).state === 'idle', 'transferStateCleared');
  await downloads.download(bad.id);
  const rejected = await downloads.settled(bad.id);
  check(
    rejected.phase === 'error' && rejected.error?.includes('checksum'),
    'checksumFailureVisible',
  );
  check((await native.getDownloadedModelFile(bad.id)) === null, 'checksumFailureNotReady');
  check(
    (await native.getModelFilePaths(bad.id)).verificationBytes === null &&
      !rejected.verificationPending,
    'checksumFailureDiscardsStagedFile',
  );
  await pauseFailureReleasesTransfer(downloads, pauseFailure);
  const storage = await downloads.refreshStorage();
  check(
    storage.usedBytes >= 2 * first.bytes &&
      storage.freeBytes > 0 &&
      storage.capacityBytes >= storage.freeBytes &&
      storage.models.some((entry) => entry.id === first.id),
    'storageOverview',
  );
  await downloads.remove(first.id);
  check(
    downloads.snapshot(first.id).phase === 'not_downloaded' &&
      (await cold.inspect(second.id)).phase === 'ready',
    'nativeRemoval',
  );
  downloads.dispose();
  cold.dispose();
}

async function run() {
  const models = await fixture();
  if (marker.exists) {
    await afterRelaunch(models);
    outcome.write(JSON.stringify({ status: 'pass', checks }));
    return 'pass';
  }
  await beforeTermination(models);
  return 'terminate';
}

let started = false;

function DownloadGate() {
  const [status, setStatus] = useState('running');
  useEffect(() => {
    if (started) {
      return;
    }
    started = true;
    void run().then(setStatus, (error: unknown) => {
      const failure = {
        status: 'fail',
        checks,
        error: error instanceof Error ? error.message : String(error),
      };
      (marker.exists ? outcome : phaseOutcome).write(JSON.stringify(failure));
      setStatus('fail');
    });
  }, []);
  return <Text>Native model transfers: {status}</Text>;
}

registerRootComponent(DownloadGate);
