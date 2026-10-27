import type { DownloadPauseState, DownloadProgress, DownloadTaskState } from 'expo-file-system';
import { localModelDefinition } from './catalog';
import {
  ModelDownloadController,
  type ModelDownloadSnapshot,
  type ModelFilePort,
} from './downloads';
import type { ModelResumeStorage, ModelTransfer, ModelTransferFactory } from './expoDownloads';
import type { LocalModelFile } from './types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function harness() {
  const model = { ...localModelDefinition('qwen3-1.7b-q4-k-m'), id: 'test-model', bytes: 10 };
  const paths = {
    partialUri: 'file:///models/test-model/partial.gguf',
    resumeUri: 'file:///models/test-model/resume.json',
    verificationBytes: null as number | null,
    availableBytes: 1024 ** 3,
  };
  const file: LocalModelFile = {
    id: model.id,
    sha256: model.sha256,
    bytes: model.bytes,
    uri: 'file:///models/test-model/ready/model.gguf',
  };
  let installed: LocalModelFile | null = null;
  const contents = new Map<string, string>();
  const events: ModelDownloadSnapshot[] = [];
  const handles: ReturnType<typeof handle>[] = [];
  const transferStarted = deferred<void>();
  const transferRestored = deferred<void>();
  function handle(progress: (value: DownloadProgress) => void) {
    let state: DownloadTaskState = 'idle';
    const result = deferred<{ uri: string } | null>();
    const started = deferred<void>();
    const saved: DownloadPauseState = {
      url: model.downloadUrl,
      fileUri: paths.partialUri,
      isDirectory: false,
      resumeData: 'opaque-resume-data',
    };
    const task = {
      get state() {
        return state;
      },
      downloadAsync: jest.fn(() => {
        state = 'active';
        started.resolve();
        transferStarted.resolve();
        return result.promise;
      }),
      resumeAsync: jest.fn(() => {
        state = 'active';
        started.resolve();
        return result.promise;
      }),
      pauseAsync: jest.fn(async () => {
        state = 'paused';
        result.resolve(null);
      }),
      cancel: jest.fn(() => {
        state = 'cancelled';
        result.reject(new Error('native cancelled'));
      }),
      savable: jest.fn(() => saved),
      release: jest.fn(),
    } satisfies ModelTransfer;
    return {
      task,
      started: started.promise,
      progress,
      saved,
      finish: () => {
        state = 'completed';
        progress({ bytesWritten: 10, totalBytes: 10 });
        result.resolve({ uri: paths.partialUri });
      },
      fail: result.reject,
    };
  }
  const transfers: ModelTransferFactory = {
    create: jest.fn((_url, _uri, progress) => {
      const item = handle(progress);
      handles.push(item);
      return item.task;
    }),
    restore: jest.fn((_state, progress) => {
      const item = handle(progress);
      handles.push(item);
      transferRestored.resolve();
      return item.task;
    }),
  };
  const native = {
    getModelFilePaths: jest.fn(async () => paths),
    getDownloadedModelFile: jest.fn(async () => installed),
    finalizeModelDownload: jest.fn(async () => {
      installed = file;
      return file;
    }),
    removeModelFile: jest.fn(async () => {
      installed = null;
      contents.delete(paths.resumeUri);
    }),
  } satisfies ModelFilePort;
  const storage = {
    read: jest.fn(async (uri: string) => contents.get(uri) ?? null),
    write: jest.fn(async (uri: string, value: string) => {
      contents.set(uri, value);
    }),
    remove: jest.fn(async (uri: string) => {
      contents.delete(uri);
    }),
  } satisfies ModelResumeStorage;
  const create = () =>
    new ModelDownloadController([model], native, transfers, storage, (state) => events.push(state));
  return {
    model,
    file,
    paths,
    native,
    storage,
    transfers,
    events,
    handles,
    contents,
    create,
    started: transferStarted.promise,
    restored: transferRestored.promise,
    installed: (value: LocalModelFile | null) => {
      installed = value;
    },
  };
}

test('unsupported runtime packings cannot start transfers through the controller API', async () => {
  const h = harness();
  const model = {
    ...h.model,
    runtimeIssue: 'This packing requires the PrismML-specific runtime.',
  };
  const controller = new ModelDownloadController(
    [model],
    h.native,
    h.transfers,
    h.storage,
    (state) => h.events.push(state),
  );
  await expect(controller.download(model.id)).rejects.toThrow('PrismML-specific runtime');
  expect(h.transfers.create).not.toHaveBeenCalled();
  expect(h.native.getModelFilePaths).not.toHaveBeenCalled();
  expect(controller.snapshot(model.id)).toMatchObject({
    phase: 'error',
    error: model.runtimeIssue,
  });
});

test('download moves through running and verifying before a verified file becomes ready', async () => {
  const h = harness();
  const verified = deferred<LocalModelFile>();
  const verifying = deferred<void>();
  h.native.finalizeModelDownload.mockImplementation(() => {
    verifying.resolve();
    return verified.promise;
  });
  const controller = h.create();
  const operation = controller.download(h.model.id);
  await h.started;
  const transfer = h.handles[0]!;
  transfer.progress({ bytesWritten: 4, totalBytes: 10 });
  expect(controller.snapshot(h.model.id)).toMatchObject({
    phase: 'downloading',
    bytesWritten: 4,
    file: null,
  });
  transfer.finish();
  await verifying.promise;
  expect(controller.snapshot(h.model.id)).toMatchObject({
    phase: 'verifying',
    file: null,
    verificationPending: true,
  });
  verified.resolve(h.file);
  await expect(operation).resolves.toMatchObject({ phase: 'ready', file: h.file });
  expect(h.native.finalizeModelDownload).toHaveBeenCalledWith(
    h.model.id,
    h.model.sha256,
    h.model.bytes,
  );
  expect(transfer.task.release).toHaveBeenCalledTimes(1);
  expect(h.events.map((state) => state.phase)).toEqual([
    'preparing',
    'downloading',
    'downloading',
    'downloading',
    'verifying',
    'ready',
  ]);
});

test('pausing persists opaque resume state before settling and a new controller resumes it', async () => {
  const h = harness();
  const first = h.create();
  const download = first.download(h.model.id);
  await h.started;
  h.handles[0]!.progress({ bytesWritten: 4, totalBytes: 10 });
  await first.pause();
  await expect(download).resolves.toMatchObject({ phase: 'paused', canResume: true });
  expect(h.contents.has(h.paths.resumeUri)).toBe(true);
  expect(h.native.finalizeModelDownload).not.toHaveBeenCalled();
  const second = h.create();
  await expect(second.inspect(h.model.id)).resolves.toMatchObject({
    phase: 'paused',
    bytesWritten: 4,
    canResume: true,
  });
  const resumed = second.resume(h.model.id);
  await h.restored;
  const transfer = h.handles[1]!;
  await transfer.started;
  expect(h.transfers.restore).toHaveBeenCalledWith(h.handles[0]!.saved, expect.any(Function));
  transfer.finish();
  await expect(resumed).resolves.toMatchObject({ phase: 'ready' });
  expect(h.contents.has(h.paths.resumeUri)).toBe(false);
});

test('checksum failures leave the model unavailable, not successfully downloaded', async () => {
  const h = harness();
  h.native.finalizeModelDownload.mockRejectedValue(new Error('Checksum mismatch.'));
  const controller = h.create();
  const operation = controller.download(h.model.id);
  const assertion = operation.catch((error: unknown) => error);
  await h.started;
  h.handles[0]!.finish();
  expect(await assertion).toEqual(new Error('Checksum mismatch.'));
  expect(controller.snapshot(h.model.id)).toMatchObject({
    phase: 'error',
    file: null,
    error: 'Checksum mismatch.',
  });
  expect(h.handles[0]!.task.release).toHaveBeenCalledTimes(1);
});

test('storage is checked before any network task starts', async () => {
  const h = harness();
  h.paths.availableBytes = 0;
  const controller = h.create();
  await expect(controller.download(h.model.id)).rejects.toThrow('Not enough free storage');
  expect(h.transfers.create).not.toHaveBeenCalled();
  expect(controller.snapshot(h.model.id).phase).toBe('error');
});

test('oversized transfer progress cancels and surfaces an integrity error', async () => {
  const h = harness();
  const controller = h.create();
  const operation = controller.download(h.model.id);
  const failure = operation.catch((error: unknown) => error);
  await h.started;
  h.handles[0]!.progress({ bytesWritten: 11, totalBytes: 11 });
  expect(await failure).toEqual(new Error('The model transfer size does not match the catalog.'));
  expect(h.handles[0]!.task.cancel).toHaveBeenCalledTimes(1);
  expect(h.native.finalizeModelDownload).not.toHaveBeenCalled();
  expect(controller.snapshot(h.model.id).phase).toBe('error');
});

test('late progress events do not change a settled model', async () => {
  const h = harness();
  const controller = h.create();
  const operation = controller.download(h.model.id);
  await h.started;
  h.handles[0]!.finish();
  await operation;
  h.handles[0]!.progress({ bytesWritten: 1, totalBytes: 10 });
  expect(controller.snapshot(h.model.id)).toMatchObject({ phase: 'ready', bytesWritten: 10 });
});

test('saved tasks cannot change the catalog URL, destination, or headers', async () => {
  for (const change of [
    { url: 'https://example.com/model.gguf' },
    { fileUri: 'file:///outside/model.gguf' },
    { headers: { Authorization: 'secret' } },
    { isDirectory: true },
  ]) {
    const h = harness();
    h.contents.set(
      h.paths.resumeUri,
      JSON.stringify({
        version: 1,
        modelId: h.model.id,
        sha256: h.model.sha256,
        bytesWritten: 4,
        task: {
          url: h.model.downloadUrl,
          fileUri: h.paths.partialUri,
          isDirectory: false,
          resumeData: 'opaque',
          ...change,
        },
      }),
    );
    const controller = h.create();
    await expect(controller.resume(h.model.id)).rejects.toThrow('origin or destination');
    expect(h.transfers.restore).not.toHaveBeenCalled();
  }
});

test('completed staging can be verified after a process restart without downloading again', async () => {
  const h = harness();
  h.paths.verificationBytes = 10;
  const controller = h.create();
  await expect(controller.inspect(h.model.id)).resolves.toMatchObject({
    phase: 'paused',
    verificationPending: true,
  });
  await expect(controller.verify(h.model.id)).resolves.toMatchObject({ phase: 'ready' });
  expect(h.transfers.create).not.toHaveBeenCalled();
  expect(h.transfers.restore).not.toHaveBeenCalled();
});

test('an installed file must match the current immutable catalog artifact', async () => {
  const h = harness();
  h.installed({ ...h.file, sha256: 'different' });
  const controller = h.create();
  await expect(controller.inspect(h.model.id)).rejects.toThrow('does not match the catalog');
  expect(controller.snapshot(h.model.id).phase).toBe('error');
});

test('a failed resume-state write does not claim a durable paused transfer', async () => {
  const h = harness();
  h.storage.write.mockRejectedValue(new Error('Storage failed.'));
  const controller = h.create();
  const operation = controller.download(h.model.id);
  const failure = operation.catch((error: unknown) => error);
  await h.started;
  await expect(controller.pause()).rejects.toThrow('Storage failed.');
  expect(await failure).toEqual(new Error('Storage failed.'));
  expect(controller.snapshot(h.model.id)).toMatchObject({ phase: 'error', canResume: false });
});

test('one controller does not start a second concurrent transfer', async () => {
  const h = harness();
  const controller = h.create();
  const operation = controller.download(h.model.id);
  await h.started;
  await expect(controller.download(h.model.id)).rejects.toThrow('Pause the active model transfer');
  h.handles[0]!.finish();
  await operation;
  expect(h.transfers.create).toHaveBeenCalledTimes(1);
});

test('cancelling before preflight completes never starts a task or leaves a paused state', async () => {
  const h = harness();
  const paths = deferred<typeof h.paths>();
  const requested = deferred<void>();
  h.native.getModelFilePaths.mockImplementation(() => {
    requested.resolve();
    return paths.promise;
  });
  const controller = h.create();
  const operation = controller.download(h.model.id);
  await requested.promise;
  const cancelled = controller.cancel();
  paths.resolve(h.paths);
  await cancelled;
  await expect(operation).resolves.toMatchObject({ phase: 'not_downloaded', canResume: false });
  expect(h.transfers.create).not.toHaveBeenCalled();
});

test('cancelling a resumed transfer removes stale resume metadata and partial files', async () => {
  const h = harness();
  const first = h.create();
  const downloading = first.download(h.model.id);
  await h.started;
  await first.pause();
  await downloading;
  const controller = h.create();
  const resumed = controller.resume(h.model.id);
  await h.restored;
  await controller.cancel();
  await expect(resumed).resolves.toMatchObject({ phase: 'not_downloaded' });
  expect(h.native.removeModelFile).toHaveBeenCalledWith(h.model.id);
  expect(h.contents.has(h.paths.resumeUri)).toBe(false);
});

test('a paused transfer without new resume data does not keep a stale previous checkpoint', async () => {
  const h = harness();
  const first = h.create();
  const downloading = first.download(h.model.id);
  await h.started;
  await first.pause();
  await downloading;
  const controller = h.create();
  const resumed = controller.resume(h.model.id);
  await h.restored;
  h.handles[1]!.saved.resumeData = undefined;
  await controller.pause();
  await expect(resumed).resolves.toMatchObject({ phase: 'paused', canResume: false });
  expect(h.contents.has(h.paths.resumeUri)).toBe(false);
});

test('native verification output is checked before a model is marked ready', async () => {
  const h = harness();
  h.native.finalizeModelDownload.mockResolvedValue({ ...h.file, sha256: 'incorrect' });
  const controller = h.create();
  const operation = controller.download(h.model.id);
  const failure = operation.catch((error: unknown) => error);
  await h.started;
  h.handles[0]!.finish();
  expect(await failure).toBeInstanceOf(Error);
  expect(controller.snapshot(h.model.id)).toMatchObject({ phase: 'error', file: null });
});
