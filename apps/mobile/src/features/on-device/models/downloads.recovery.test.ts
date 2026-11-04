import type { NativeModelTransfer } from './downloadState';
import { BYTES, deferred, harness, idle, POLL } from './testing';

const tick = (ms = POLL) => jest.advanceTimersByTimeAsync(ms);

function running(id: string, bytesWritten = 10): NativeModelTransfer {
  return { ...idle(id), state: 'running', bytesWritten, totalBytes: BYTES };
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('download preflight edge cases', () => {
  it('returns the current snapshot instead of starting a second transfer for the same model', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    const started = deferred<NativeModelTransfer>();
    h.native.startModelDownload.mockImplementationOnce(() => started.promise);

    const first = controller.download('model-a');
    await tick(0);
    await expect(controller.download('model-a')).resolves.toMatchObject({ phase: 'preparing' });
    await expect(controller.resume('model-a')).resolves.toMatchObject({ phase: 'preparing' });

    started.resolve(running('model-a', 0));
    await expect(first).resolves.toMatchObject({ phase: 'downloading' });
    expect(h.native.startModelDownload).toHaveBeenCalledTimes(1);
  });

  it('marks an already-installed model ready without downloading it again', async () => {
    const h = harness(['model-a']);
    h.installed.set('model-a', h.file('model-a'));
    const controller = h.create();

    await expect(controller.download('model-a')).resolves.toMatchObject({
      phase: 'ready',
      file: h.file('model-a'),
      bytesWritten: BYTES,
    });
    expect(h.native.startModelDownload).not.toHaveBeenCalled();
    // The slot was never taken: another download can start immediately.
    expect(controller.snapshot('model-a').phase).toBe('ready');
  });

  it('adopts a transfer the background session re-attached during preflight', async () => {
    const h = harness(['model-a']);
    h.transfers.set('model-a', running('model-a', 42));
    const controller = h.create();

    await expect(controller.download('model-a')).resolves.toMatchObject({
      phase: 'downloading',
      bytesWritten: 42,
      canResume: false,
    });
    expect(h.native.startModelDownload).not.toHaveBeenCalled();
    expect(h.native.getDownloadedModelFile).not.toHaveBeenCalled();
  });

  it('adopts a running transfer that native reports after attach missed it', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    h.native.attachModelDownloads.mockResolvedValueOnce([]);
    h.transfers.set('model-a', running('model-a', 17));

    await expect(controller.download('model-a')).resolves.toMatchObject({
      phase: 'downloading',
      bytesWritten: 17,
    });
    expect(h.native.startModelDownload).not.toHaveBeenCalled();

    h.progress('model-a', 60);
    await tick();
    expect(controller.snapshot('model-a')).toMatchObject({
      phase: 'downloading',
      bytesWritten: 60,
    });
  });

  it('refuses to restart a download over a file waiting for verification', async () => {
    const h = harness(['model-a']);
    h.staged.add('model-a');
    const controller = h.create();

    await expect(controller.download('model-a')).rejects.toThrow(
      'Verify the pending model file or remove it before restarting its download.',
    );
    expect(h.native.startModelDownload).not.toHaveBeenCalled();
    expect(controller.snapshot('model-a')).toMatchObject({
      phase: 'error',
      error: 'Verify the pending model file or remove it before restarting its download.',
    });
    // Verification is still possible afterwards.
    await expect(controller.verify('model-a')).resolves.toMatchObject({ phase: 'verifying' });
    await expect(controller.settled('model-a')).resolves.toMatchObject({ phase: 'ready' });
  });

  it('refuses to verify when no completed download exists', async () => {
    const h = harness(['model-a']);
    const controller = h.create();

    await expect(controller.verify('model-a')).rejects.toThrow(
      'No completed download is waiting for verification.',
    );
    expect(h.native.finalizeModelDownload).not.toHaveBeenCalled();
    expect(controller.snapshot('model-a').phase).toBe('error');
  });

  it('retries attaching background transfers after a failed attach', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    h.native.attachModelDownloads.mockRejectedValueOnce(new Error('Session unavailable.'));

    await expect(controller.download('model-a')).rejects.toThrow('Session unavailable.');
    expect(controller.snapshot('model-a')).toMatchObject({
      phase: 'error',
      error: 'Session unavailable.',
    });

    await expect(controller.download('model-a')).resolves.toMatchObject({
      phase: 'downloading',
    });
    expect(h.native.attachModelDownloads).toHaveBeenCalledTimes(2);
  });

  it('pausing during preflight never starts the transfer and settles to its resting state', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    const paths = deferred<Awaited<ReturnType<typeof h.native.getModelFilePaths>>>();
    const requested = deferred<void>();
    h.native.getModelFilePaths.mockImplementationOnce(() => {
      requested.resolve();
      return paths.promise;
    });

    const download = controller.download('model-a');
    await requested.promise;
    const pause = controller.pause('model-a');
    paths.resolve({
      partialUri: 'file:///p',
      resumeUri: 'file:///r',
      verificationBytes: null,
      availableBytes: 1024 ** 3,
    });

    await expect(download).resolves.toMatchObject({ phase: 'not_downloaded' });
    await expect(pause).resolves.toMatchObject({ phase: 'not_downloaded' });
    expect(h.native.startModelDownload).not.toHaveBeenCalled();
    expect(h.native.removeModelFile).not.toHaveBeenCalled();
  });
});

describe('pausing and cancelling in-flight work', () => {
  it('waits for a starting transfer, then pauses it natively', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    const started = deferred<NativeModelTransfer>();
    h.native.startModelDownload.mockImplementationOnce(async (id) => {
      const transfer = await started.promise;
      h.transfers.set(id, transfer);
      return transfer;
    });

    const download = controller.download('model-a');
    await tick(0);
    expect(h.native.startModelDownload).toHaveBeenCalledTimes(1);
    const pause = controller.pause('model-a');
    expect(h.native.pauseModelDownload).not.toHaveBeenCalled();

    started.resolve(running('model-a', 25));
    await download;
    await expect(pause).resolves.toMatchObject({
      phase: 'paused',
      canResume: true,
      bytesWritten: 25,
    });
    expect(h.native.pauseModelDownload).toHaveBeenCalledWith('model-a');
  });

  it('verifies a transfer that completed as it was being paused', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    await controller.download('model-a');
    const finalized = deferred<ReturnType<typeof h.file>>();
    h.native.finalizeModelDownload.mockImplementationOnce(() => finalized.promise);
    h.native.pauseModelDownload.mockImplementationOnce(async (id) => {
      h.complete(id);
      return { ...idle(id), state: 'completed', bytesWritten: BYTES, totalBytes: BYTES };
    });

    await expect(controller.pause('model-a')).resolves.toMatchObject({
      phase: 'verifying',
      verificationPending: true,
      bytesWritten: BYTES,
    });
    expect(h.native.finalizeModelDownload).toHaveBeenCalledWith(
      'model-a',
      expect.any(String),
      BYTES,
    );

    finalized.resolve(h.file('model-a'));
    await expect(controller.settled('model-a')).resolves.toMatchObject({ phase: 'ready' });
  });

  it('explains when the server could not keep a paused transfer resumable', async () => {
    const h = harness(['model-a', 'model-b', 'model-c']);
    const controller = h.create();
    await controller.download('model-a');
    await controller.download('model-b');
    await controller.download('model-c');
    expect(controller.snapshot('model-c').phase).toBe('queued');
    h.native.pauseModelDownload.mockImplementationOnce(async (id) => {
      h.transfers.delete(id);
      return idle(id);
    });

    await expect(controller.pause('model-a')).resolves.toMatchObject({
      phase: 'not_downloaded',
      canResume: false,
      error: 'This server could not save the transfer for resuming. Download it again.',
    });
    // The freed slot goes to the queued model.
    expect(controller.snapshot('model-c').phase).toBe('downloading');
  });

  it('cancelling a paused model discards its partial data; pausing it again is a no-op', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    await controller.download('model-a');
    h.progress('model-a', 30);
    await tick();
    await controller.pause('model-a');
    h.native.pauseModelDownload.mockClear();

    await expect(controller.pause('model-a')).resolves.toMatchObject({ phase: 'paused' });
    expect(h.native.pauseModelDownload).not.toHaveBeenCalled();

    await expect(controller.cancel('model-a')).resolves.toMatchObject({
      phase: 'not_downloaded',
      bytesWritten: 0,
      canResume: false,
    });
    expect(h.native.removeModelFile).toHaveBeenCalledWith('model-a');
    expect(h.transfers.has('model-a')).toBe(false);
  });

  it('never deletes an installed model on cancel', async () => {
    const h = harness(['model-a']);
    h.installed.set('model-a', h.file('model-a'));
    const controller = h.create();
    await controller.inspect('model-a');

    await expect(controller.cancel('model-a')).resolves.toMatchObject({ phase: 'ready' });
    expect(h.native.removeModelFile).not.toHaveBeenCalled();
  });
});

describe('removing models', () => {
  it('stops verification before deleting the model files', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    await controller.download('model-a');
    const finalized = deferred<never>();
    h.native.finalizeModelDownload.mockImplementationOnce(() => finalized.promise);
    h.native.cancelModelVerification.mockImplementationOnce(() => {
      finalized.reject(new Error('Verification cancelled.'));
    });
    h.complete('model-a');
    await tick();
    expect(controller.snapshot('model-a').phase).toBe('verifying');

    await controller.remove('model-a');

    expect(h.native.cancelModelVerification).toHaveBeenCalledWith('model-a');
    expect(h.native.removeModelFile).toHaveBeenCalledWith('model-a');
    expect(controller.snapshot('model-a')).toMatchObject({
      phase: 'not_downloaded',
      verificationPending: false,
      error: null,
    });
    expect(h.staged.has('model-a')).toBe(false);
  });

  it('rejects and records the error when native deletion fails', async () => {
    const h = harness(['model-a']);
    h.installed.set('model-a', h.file('model-a'));
    const controller = h.create();
    await controller.inspect('model-a');
    h.native.removeModelFile.mockRejectedValueOnce(new Error('File is busy.'));

    await expect(controller.remove('model-a')).rejects.toThrow('File is busy.');
    expect(controller.snapshot('model-a')).toMatchObject({
      phase: 'error',
      error: 'File is busy.',
    });
  });
});

describe('queue and slot release', () => {
  it('reports a queued start failure on that model and starts the next one', async () => {
    const h = harness(['model-a', 'model-b', 'model-c'], { maxConcurrent: 1 });
    const controller = h.create();
    await controller.download('model-a');
    await expect(controller.download('model-b')).resolves.toMatchObject({ phase: 'queued' });
    await expect(controller.download('model-c')).resolves.toMatchObject({ phase: 'queued' });
    h.native.startModelDownload.mockRejectedValueOnce(new Error('Session invalidated.'));

    h.complete('model-a');
    await tick();
    await tick(0);

    expect(controller.snapshot('model-b')).toMatchObject({
      phase: 'error',
      error: 'Session invalidated.',
    });
    expect(controller.snapshot('model-c').phase).toBe('downloading');
    expect(h.native.startModelDownload).toHaveBeenLastCalledWith(
      'model-c',
      'https://models.example/model-c.gguf',
      BYTES,
    );
  });

  it('frees the slot when native transfer state cannot be read while polling', async () => {
    const h = harness(['model-a', 'model-b'], { maxConcurrent: 1 });
    const controller = h.create();
    await controller.download('model-a');
    await controller.download('model-b');
    const read = h.native.getModelDownload.getMockImplementation()!;
    h.native.getModelDownload.mockImplementation((id: string) => {
      if (id === 'model-a') {
        throw new Error('Transfer state unavailable.');
      }
      return read(id);
    });

    await tick();
    await tick(0);

    expect(controller.snapshot('model-a')).toMatchObject({
      phase: 'error',
      error: 'Transfer state unavailable.',
    });
    expect(controller.snapshot('model-b').phase).toBe('downloading');
  });

  it('stops polling once no model has work, and resumes polling for new work', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    await controller.download('model-a');
    await controller.pause('model-a');
    await tick();
    h.native.getModelDownload.mockClear();
    h.native.getModelVerificationProgress.mockClear();

    await tick(POLL * 4);
    expect(h.native.getModelDownload).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    await controller.resume('model-a');
    await tick();
    expect(h.native.getModelDownload).toHaveBeenCalledWith('model-a');
  });

  it('keeps the last verification progress while native reports no active hash', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    await controller.download('model-a');
    const finalized = deferred<ReturnType<typeof h.file>>();
    h.native.finalizeModelDownload.mockImplementationOnce(() => finalized.promise);
    h.complete('model-a');
    h.verification.set('model-a', { completed: 40, cancelled: false });
    await tick();
    await tick();
    expect(controller.snapshot('model-a')).toMatchObject({ phase: 'verifying', verifiedBytes: 40 });

    h.verification.delete('model-a');
    await tick();
    await tick();
    expect(controller.snapshot('model-a')).toMatchObject({ phase: 'verifying', verifiedBytes: 40 });

    finalized.resolve(h.file('model-a'));
    await expect(controller.settled('model-a')).resolves.toMatchObject({ phase: 'ready' });
  });

  it('does not start queued work after dispose', async () => {
    const h = harness(['model-a', 'model-b'], { maxConcurrent: 1 });
    const controller = h.create();
    await controller.download('model-a');
    await controller.download('model-b');
    controller.dispose();

    await controller.cancel('model-a');

    expect(controller.snapshot('model-b').phase).toBe('queued');
    expect(h.native.startModelDownload).toHaveBeenCalledTimes(1);
  });
});

describe('inspection', () => {
  it('adopts a background transfer found while inspecting instead of reading files', async () => {
    const h = harness(['model-a']);
    h.transfers.set('model-a', running('model-a', 55));
    const controller = h.create();

    await expect(controller.inspect('model-a')).resolves.toMatchObject({
      phase: 'downloading',
      bytesWritten: 55,
    });
    expect(h.native.getDownloadedModelFile).not.toHaveBeenCalled();
  });

  it('returns the live snapshot for a model with work in progress', async () => {
    const h = harness(['model-a']);
    const controller = h.create();
    await controller.download('model-a');
    h.native.getModelFilePaths.mockClear();
    h.native.getDownloadedModelFile.mockClear();

    await expect(controller.inspect('model-a')).resolves.toMatchObject({ phase: 'downloading' });
    expect(h.native.getModelFilePaths).not.toHaveBeenCalled();
    expect(h.native.getDownloadedModelFile).not.toHaveBeenCalled();
  });
});
