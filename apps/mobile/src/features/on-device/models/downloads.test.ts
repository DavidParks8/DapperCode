import { localModelDefinition } from './catalog';
import type { NativeModelTransfer } from './downloadState';
import {
  ModelDownloadController,
  type ModelDownloadOptions,
  type ModelDownloadSnapshot,
  type ModelFilePort,
} from './downloads';
import type { LocalModelDefinition, LocalModelFile } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const BYTES = 100;
const POLL = 250;

function idle(id: string): NativeModelTransfer {
  return {
    id,
    state: 'idle',
    bytesWritten: 0,
    totalBytes: 0,
    resumable: false,
    interrupted: false,
    error: null,
  };
}

/** Simulates the native background URL session and model file store. */
function harness(ids = ['model-a', 'model-b', 'model-c'], options: ModelDownloadOptions = {}) {
  const base = localModelDefinition('qwen3-1.7b-q4-k-m');
  const models: LocalModelDefinition[] = ids.map((id) => ({
    ...base,
    id,
    bytes: BYTES,
    downloadUrl: `https://models.example/${id}.gguf`,
  }));
  const transfers = new Map<string, NativeModelTransfer>();
  const staged = new Set<string>();
  const installed = new Map<string, LocalModelFile>();
  const verification = new Map<string, { completed: number; cancelled: boolean }>();
  let availableBytes = 1024 ** 3;
  const file = (id: string): LocalModelFile => ({
    id,
    sha256: base.sha256,
    bytes: BYTES,
    uri: `file:///models/${id}/ready/model.gguf`,
  });
  const native = {
    attachModelDownloads: jest.fn(async () =>
      [...transfers.values()].filter((transfer) => transfer.state === 'running'),
    ),
    startModelDownload: jest.fn(async (id: string, _url: string, totalBytes: number) => {
      const paused = transfers.get(id);
      const transfer: NativeModelTransfer = {
        ...idle(id),
        state: 'running',
        totalBytes,
        bytesWritten: paused?.state === 'paused' ? paused.bytesWritten : 0,
      };
      transfers.set(id, transfer);
      return transfer;
    }),
    pauseModelDownload: jest.fn(async (id: string) => {
      const current = transfers.get(id);
      if (current?.state === 'running') {
        transfers.set(id, { ...current, state: 'paused', resumable: true });
      }
      return transfers.get(id) ?? idle(id);
    }),
    cancelModelDownload: jest.fn(async (id: string) => {
      transfers.delete(id);
    }),
    getModelDownload: jest.fn((id: string) =>
      staged.has(id)
        ? { ...idle(id), state: 'completed' as const, bytesWritten: BYTES, totalBytes: BYTES }
        : (transfers.get(id) ?? idle(id)),
    ),
    getModelFilePaths: jest.fn(async (id: string) => ({
      partialUri: `file:///models/${id}/partial.gguf`,
      resumeUri: `file:///models/${id}/resume.json`,
      verificationBytes: staged.has(id) ? BYTES : null,
      availableBytes,
    })),
    getDownloadedModelFile: jest.fn(async (id: string) => installed.get(id) ?? null),
    finalizeModelDownload: jest.fn(async (id: string) => {
      staged.delete(id);
      installed.set(id, file(id));
      return file(id);
    }),
    removeModelFile: jest.fn(async (id: string) => {
      transfers.delete(id);
      staged.delete(id);
      installed.delete(id);
    }),
    getModelVerificationProgress: jest.fn((id: string) => {
      const progress = verification.get(id);
      return progress
        ? { active: true, completed: progress.completed, total: BYTES }
        : { active: false, completed: 0, total: 0 };
    }),
    cancelModelVerification: jest.fn((id: string) => {
      const progress = verification.get(id);
      if (progress) {
        progress.cancelled = true;
      }
    }),
    getModelStorageInfo: jest.fn(async () => ({
      usedBytes: installed.size * BYTES,
      freeBytes: availableBytes,
      capacityBytes: 8 * 1024 ** 3,
      models: [...installed.keys()].map((id) => ({ id, bytes: BYTES })),
    })),
  } satisfies ModelFilePort;
  const events: ModelDownloadSnapshot[] = [];
  const create = () =>
    new ModelDownloadController(
      models,
      native,
      (snapshot) => {
        if (snapshot) {
          events.push(snapshot);
        }
      },
      options,
    );
  return {
    models,
    native,
    events,
    transfers,
    staged,
    installed,
    verification,
    file,
    create,
    setAvailable: (bytes: number) => {
      availableBytes = bytes;
    },
    progress: (id: string, bytesWritten: number) => {
      const current = transfers.get(id);
      if (!current) {
        throw new Error(`No transfer for ${id}`);
      }
      transfers.set(id, { ...current, bytesWritten });
    },
    complete: (id: string) => {
      transfers.delete(id);
      staged.add(id);
    },
    interrupt: (id: string, bytesWritten: number) => {
      transfers.set(id, {
        ...idle(id),
        state: 'paused',
        bytesWritten,
        totalBytes: BYTES,
        resumable: true,
        interrupted: true,
        error: 'The network connection was lost.',
      });
    },
  };
}

const tick = (ms = POLL) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test('unsupported runtime packings cannot start transfers through the controller API', async () => {
  const h = harness(['model-a']);
  h.models[0] = { ...h.models[0]!, runtimeIssue: 'This packing requires the PrismML runtime.' };
  const controller = h.create();
  await expect(controller.download('model-a')).rejects.toThrow('PrismML runtime');
  expect(h.native.startModelDownload).not.toHaveBeenCalled();
  expect(h.native.getModelFilePaths).not.toHaveBeenCalled();
  expect(controller.snapshot('model-a')).toMatchObject({
    phase: 'error',
    error: 'This packing requires the PrismML runtime.',
  });
});

test('download resolves once the background transfer starts, then verifies before ready', async () => {
  const h = harness(['model-a']);
  const controller = h.create();
  await expect(controller.download('model-a')).resolves.toMatchObject({
    phase: 'downloading',
    bytesWritten: 0,
  });
  expect(h.native.startModelDownload).toHaveBeenCalledWith(
    'model-a',
    'https://models.example/model-a.gguf',
    BYTES,
  );
  expect(h.native.finalizeModelDownload).not.toHaveBeenCalled();
  h.progress('model-a', 40);
  await tick();
  expect(controller.snapshot('model-a')).toMatchObject({ phase: 'downloading', bytesWritten: 40 });
  const finalized = deferred<LocalModelFile>();
  h.native.finalizeModelDownload.mockImplementationOnce(() => finalized.promise);
  h.complete('model-a');
  await tick();
  expect(controller.snapshot('model-a')).toMatchObject({
    phase: 'verifying',
    verificationPending: true,
    file: null,
  });
  finalized.resolve(h.file('model-a'));
  await expect(controller.settled('model-a')).resolves.toMatchObject({
    phase: 'ready',
    file: h.file('model-a'),
  });
  expect(h.events.map((event) => event.phase)).toEqual([
    'preparing',
    'downloading',
    'downloading',
    'verifying',
    'ready',
  ]);
});

test('two models download concurrently and pausing one leaves the other running', async () => {
  const h = harness();
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  expect(h.native.startModelDownload).toHaveBeenCalledTimes(2);
  expect(controller.snapshot('model-a').phase).toBe('downloading');
  expect(controller.snapshot('model-b').phase).toBe('downloading');
  h.progress('model-a', 30);
  h.progress('model-b', 20);
  await tick();
  await expect(controller.pause('model-a')).resolves.toMatchObject({
    phase: 'paused',
    canResume: true,
    bytesWritten: 30,
  });
  expect(h.native.pauseModelDownload).toHaveBeenCalledWith('model-a');
  expect(h.native.pauseModelDownload).not.toHaveBeenCalledWith('model-b');
  h.progress('model-b', 60);
  await tick();
  expect(controller.snapshot('model-b')).toMatchObject({ phase: 'downloading', bytesWritten: 60 });
  expect(controller.snapshot('model-a')).toMatchObject({ phase: 'paused', bytesWritten: 30 });
  await expect(controller.resume('model-a')).resolves.toMatchObject({
    phase: 'downloading',
    bytesWritten: 30,
  });
});

test('downloads beyond the concurrency limit queue and start when a slot frees', async () => {
  const h = harness();
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  await expect(controller.download('model-c')).resolves.toMatchObject({ phase: 'queued' });
  expect(h.native.startModelDownload).toHaveBeenCalledTimes(2);
  h.complete('model-a');
  await tick();
  expect(h.native.startModelDownload).toHaveBeenLastCalledWith(
    'model-c',
    'https://models.example/model-c.gguf',
    BYTES,
  );
  expect(controller.snapshot('model-c').phase).toBe('downloading');
  await controller.settled('model-a');
  expect(controller.snapshot('model-a').phase).toBe('ready');
});

test('queued downloads can be paused or cancelled without touching running transfers', async () => {
  const h = harness();
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  await controller.download('model-c');
  await expect(controller.pause('model-c')).resolves.toMatchObject({ phase: 'not_downloaded' });
  await controller.download('model-c');
  await expect(controller.cancel('model-c')).resolves.toMatchObject({ phase: 'not_downloaded' });
  await controller.cancel('model-a');
  expect(h.native.startModelDownload).not.toHaveBeenCalledWith(
    'model-c',
    expect.anything(),
    expect.anything(),
  );
  expect(controller.snapshot('model-b').phase).toBe('downloading');
});

test('free-space checks reserve the bytes still needed by concurrent transfers', async () => {
  const h = harness();
  h.setAvailable(64 * 1024 * 1024 + 2 * BYTES + 50);
  const controller = h.create();
  await controller.download('model-a');
  await expect(controller.download('model-b')).resolves.toMatchObject({ phase: 'downloading' });
  await expect(controller.download('model-c')).rejects.toThrow('Not enough free storage');
  expect(controller.snapshot('model-c')).toMatchObject({ phase: 'error' });
  expect(h.native.startModelDownload).toHaveBeenCalledTimes(2);
  expect(controller.storage()).toBeNull();
  await expect(controller.refreshStorage()).resolves.toMatchObject({ reservedBytes: 2 * BYTES });
});

test('progress publishes are throttled per model and include speed and remaining time', async () => {
  const h = harness(['model-a'], { pollIntervalMs: 50, publishIntervalMs: 250 });
  const controller = h.create();
  await controller.download('model-a');
  const before = h.events.length;
  for (let step = 1; step <= 20; step += 1) {
    h.progress('model-a', step * 2);
    await tick(50);
  }
  const published = h.events.length - before;
  expect(published).toBeGreaterThanOrEqual(3);
  expect(published).toBeLessThanOrEqual(5);
  expect(controller.snapshot('model-a')).toMatchObject({ bytesWritten: 40 });
  expect(controller.snapshot('model-a').bytesPerSecond).toBe(40);
  expect(controller.snapshot('model-a').etaSeconds).toBe(2);
});

test('a paused transfer is restored by a new controller and resumes from its checkpoint', async () => {
  const h = harness(['model-a']);
  const first = h.create();
  await first.download('model-a');
  h.progress('model-a', 40);
  await tick();
  await first.pause('model-a');
  first.dispose();
  const second = h.create();
  await expect(second.inspect('model-a')).resolves.toMatchObject({
    phase: 'paused',
    canResume: true,
    bytesWritten: 40,
    interrupted: false,
  });
  await expect(second.resume('model-a')).resolves.toMatchObject({
    phase: 'downloading',
    bytesWritten: 40,
  });
  h.complete('model-a');
  await tick();
  await expect(second.settled('model-a')).resolves.toMatchObject({ phase: 'ready' });
});

test('a new controller re-attaches a transfer that kept running in the background session', async () => {
  const h = harness(['model-a']);
  const first = h.create();
  await first.download('model-a');
  first.dispose();
  h.progress('model-a', 70);
  const second = h.create();
  await expect(second.inspect('model-a')).resolves.toMatchObject({
    phase: 'downloading',
    bytesWritten: 70,
  });
  expect(h.native.startModelDownload).toHaveBeenCalledTimes(1);
  h.complete('model-a');
  await tick();
  await expect(second.settled('model-a')).resolves.toMatchObject({ phase: 'ready' });
});

test('becoming active resumes system-interrupted transfers but not user-paused ones', async () => {
  const h = harness(['model-a', 'model-b', 'model-c']);
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  await controller.pause('model-b');
  h.interrupt('model-a', 25);
  await tick();
  expect(controller.snapshot('model-a')).toMatchObject({
    phase: 'paused',
    interrupted: true,
    canResume: true,
    error: 'The network connection was lost.',
  });
  h.staged.add('model-c');
  await controller.resumeLifecyclePaused();
  expect(controller.snapshot('model-a')).toMatchObject({
    phase: 'downloading',
    bytesWritten: 25,
    error: null,
  });
  expect(controller.snapshot('model-b')).toMatchObject({ phase: 'paused', interrupted: false });
  await expect(controller.settled('model-c')).resolves.toMatchObject({ phase: 'ready' });
  await controller.resumeAll();
  expect(controller.snapshot('model-b').phase).toBe('downloading');
});

test('verification reports progress and can be paused or cancelled cooperatively', async () => {
  const h = harness(['model-a', 'model-b']);
  const hashing = new Map<string, ReturnType<typeof deferred<LocalModelFile>>>();
  h.native.finalizeModelDownload.mockImplementation((id: string) => {
    const pending = deferred<LocalModelFile>();
    hashing.set(id, pending);
    h.verification.set(id, { completed: 0, cancelled: false });
    return pending.promise;
  });
  h.native.cancelModelVerification.mockImplementation((id: string) => {
    h.verification.delete(id);
    hashing.get(id)?.reject(new Error('Model verification was cancelled.'));
  });
  h.staged.add('model-a');
  h.staged.add('model-b');
  const controller = h.create();
  await expect(controller.verify('model-a')).resolves.toMatchObject({ phase: 'verifying' });
  await controller.verify('model-b');
  h.verification.set('model-a', { completed: 50, cancelled: false });
  await tick();
  expect(controller.snapshot('model-a')).toMatchObject({ phase: 'verifying', verifiedBytes: 50 });
  await expect(controller.pause('model-a')).resolves.toMatchObject({
    phase: 'paused',
    verificationPending: true,
    error: null,
  });
  expect(h.native.removeModelFile).not.toHaveBeenCalled();
  await expect(controller.cancel('model-b')).resolves.toMatchObject({ phase: 'not_downloaded' });
  expect(h.native.cancelModelVerification).toHaveBeenCalledWith('model-b');
  expect(h.native.removeModelFile).toHaveBeenCalledWith('model-b');
  expect(h.native.removeModelFile).not.toHaveBeenCalledWith('model-a');
});

test('checksum failures leave the model unavailable, not successfully downloaded', async () => {
  const h = harness(['model-a']);
  h.native.finalizeModelDownload.mockRejectedValue(new Error('Checksum mismatch.'));
  const controller = h.create();
  await controller.download('model-a');
  h.complete('model-a');
  await tick();
  await expect(controller.settled('model-a')).resolves.toMatchObject({
    phase: 'error',
    file: null,
    error: 'Checksum mismatch.',
  });
});

test('native verification output is checked before a model is marked ready', async () => {
  const h = harness(['model-a']);
  h.native.finalizeModelDownload.mockResolvedValue({ ...h.file('model-a'), sha256: 'incorrect' });
  h.staged.add('model-a');
  const controller = h.create();
  await controller.verify('model-a');
  await expect(controller.settled('model-a')).resolves.toMatchObject({
    phase: 'error',
    file: null,
  });
});

test('pause and cancel failures are recorded on that model instead of rejecting', async () => {
  const h = harness(['model-a', 'model-b']);
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  h.native.pauseModelDownload.mockRejectedValueOnce(new Error('Pause failed.'));
  await expect(controller.pause('model-a')).resolves.toMatchObject({
    phase: 'downloading',
    error: 'Pause failed.',
  });
  h.native.removeModelFile.mockRejectedValueOnce(new Error('Cancel failed.'));
  await expect(controller.cancel('model-a')).resolves.toMatchObject({
    phase: 'error',
    error: 'Cancel failed.',
  });
  expect(controller.snapshot('model-b')).toMatchObject({ phase: 'downloading', error: null });
});

test('oversized transfer progress discards the transfer and surfaces an integrity error', async () => {
  const h = harness(['model-a']);
  const controller = h.create();
  await controller.download('model-a');
  h.progress('model-a', BYTES + 1);
  await tick();
  await expect(controller.settled('model-a')).resolves.toMatchObject({
    phase: 'error',
    error: 'The model transfer size does not match the catalog.',
  });
  expect(h.native.removeModelFile).toHaveBeenCalledWith('model-a');
  expect(h.native.finalizeModelDownload).not.toHaveBeenCalled();
});

test('native failures after start are reported on the snapshot and free the slot', async () => {
  const h = harness();
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  await controller.download('model-c');
  h.transfers.set('model-a', {
    ...idle('model-a'),
    state: 'failed',
    error: 'The model server returned HTTP 503.',
  });
  await tick();
  expect(controller.snapshot('model-a')).toMatchObject({
    phase: 'error',
    error: 'The model server returned HTTP 503.',
  });
  expect(controller.snapshot('model-c').phase).toBe('downloading');
});

test('cancelling before preflight completes never starts a transfer', async () => {
  const h = harness(['model-a']);
  const paths = deferred<Awaited<ReturnType<ModelFilePort['getModelFilePaths']>>>();
  const requested = deferred<void>();
  h.native.getModelFilePaths.mockImplementationOnce(() => {
    requested.resolve();
    return paths.promise;
  });
  const controller = h.create();
  const operation = controller.download('model-a');
  await requested.promise;
  const cancelled = controller.cancel('model-a');
  paths.resolve({
    partialUri: 'file:///partial',
    resumeUri: 'file:///resume',
    verificationBytes: null,
    availableBytes: 1024 ** 3,
  });
  await expect(cancelled).resolves.toMatchObject({ phase: 'not_downloaded' });
  await expect(operation).resolves.toMatchObject({ phase: 'not_downloaded', canResume: false });
  expect(h.native.startModelDownload).not.toHaveBeenCalled();
});

test('resume requires a resumable checkpoint', async () => {
  const h = harness(['model-a']);
  const controller = h.create();
  await expect(controller.resume('model-a')).rejects.toThrow('No resumable transfer');
  expect(h.native.startModelDownload).not.toHaveBeenCalled();
});

test('an installed file must match the current immutable catalog artifact', async () => {
  const h = harness(['model-a']);
  h.installed.set('model-a', { ...h.file('model-a'), sha256: 'different' });
  const controller = h.create();
  await expect(controller.inspect('model-a')).rejects.toThrow('does not match the catalog');
  expect(controller.snapshot('model-a').phase).toBe('error');
});

test('a completed transfer found after relaunch is pending verification and auto-verifies', async () => {
  const h = harness(['model-a']);
  h.staged.add('model-a');
  const controller = h.create();
  await expect(controller.inspect('model-a')).resolves.toMatchObject({
    phase: 'paused',
    verificationPending: true,
    interrupted: true,
  });
  await controller.resumeLifecyclePaused();
  await expect(controller.settled('model-a')).resolves.toMatchObject({ phase: 'ready' });
});

test('removing an installed model deletes it without disturbing another transfer', async () => {
  const h = harness(['model-a', 'model-b']);
  h.installed.set('model-a', h.file('model-a'));
  const controller = h.create();
  await controller.inspect('model-a');
  await controller.download('model-b');
  await controller.remove('model-a');
  expect(controller.snapshot('model-a').phase).toBe('not_downloaded');
  expect(controller.snapshot('model-b').phase).toBe('downloading');
  expect(h.native.removeModelFile).toHaveBeenCalledTimes(1);
  await expect(controller.refreshStorage()).resolves.toMatchObject({
    usedBytes: 0,
    reservedBytes: BYTES,
  });
  expect(controller.storage()).toMatchObject({ usedBytes: 0, reservedBytes: BYTES });
});

test('pauseAll pauses running and queued work for every model', async () => {
  const h = harness();
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  await controller.download('model-c');
  await controller.pauseAll();
  expect(controller.snapshot('model-a')).toMatchObject({ phase: 'paused', canResume: true });
  expect(controller.snapshot('model-b')).toMatchObject({ phase: 'paused', canResume: true });
  expect(controller.snapshot('model-c')).toMatchObject({ phase: 'not_downloaded' });
  expect(h.native.startModelDownload).toHaveBeenCalledTimes(2);
});

test('a failed native pause that ended the transfer releases its slot and reservation', async () => {
  const h = harness();
  h.setAvailable(64 * 1024 * 1024 + 3 * BYTES);
  const controller = h.create();
  await controller.download('model-a');
  await controller.download('model-b');
  await controller.download('model-c');
  h.native.pauseModelDownload.mockImplementationOnce(async (id: string) => {
    h.transfers.set(id, {
      ...idle(id),
      state: 'failed',
      error: 'The paused download could not be saved. Restart it.',
    });
    throw new Error('Disk full.');
  });
  await expect(controller.pause('model-a')).resolves.toMatchObject({
    phase: 'error',
    canResume: false,
    error: 'Disk full.',
  });
  expect(controller.snapshot('model-c').phase).toBe('downloading');
  await expect(controller.refreshStorage()).resolves.toMatchObject({ reservedBytes: 2 * BYTES });
  await tick();
  expect(controller.snapshot('model-a')).toMatchObject({ phase: 'error', error: 'Disk full.' });
});

test('a checksum mismatch is not re-verified on later activations', async () => {
  const h = harness(['model-a']);
  h.native.finalizeModelDownload.mockImplementation(async (id: string) => {
    h.staged.delete(id);
    throw new Error('The model checksum does not match the catalog. Restart the download.');
  });
  h.staged.add('model-a');
  const controller = h.create();
  await controller.inspect('model-a');
  await controller.resumeLifecyclePaused();
  await expect(controller.settled('model-a')).resolves.toMatchObject({
    phase: 'error',
    verificationPending: false,
  });
  await controller.resumeLifecyclePaused();
  const relaunched = h.create();
  await expect(relaunched.inspect('model-a')).resolves.toMatchObject({
    phase: 'not_downloaded',
    verificationPending: false,
  });
  await relaunched.resumeLifecyclePaused();
  expect(h.native.finalizeModelDownload).toHaveBeenCalledTimes(1);
});
