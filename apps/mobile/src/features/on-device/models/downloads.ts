import type { DownloadProgress } from 'expo-file-system';
import type { OnDeviceNativeServices } from '../native/services.types';
import { parseSavedModelDownload } from './downloadState';
import type { SavedModelDownload } from './downloadState';
import type { ModelResumeStorage, ModelTransfer, ModelTransferFactory } from './expoDownloads';
import type { LocalModelDefinition, LocalModelFile, LocalModelPaths } from './types';

export type ModelDownloadPhase =
  | 'loading'
  | 'not_downloaded'
  | 'preparing'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'ready'
  | 'error';

export interface ModelDownloadSnapshot {
  modelId: string;
  phase: ModelDownloadPhase;
  bytesWritten: number;
  canResume: boolean;
  verificationPending: boolean;
  file: LocalModelFile | null;
  error: string | null;
}

export type ModelFilePort = Pick<
  OnDeviceNativeServices,
  'getModelFilePaths' | 'getDownloadedModelFile' | 'finalizeModelDownload' | 'removeModelFile'
>;

interface DownloadOperation {
  model: LocalModelDefinition;
  task: ModelTransfer | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  bytesWritten: number;
  failure: Error | null;
}

const DISK_RESERVE_BYTES = 64 * 1024 * 1024;

class ModelTransferCancelled extends Error {}

export class ModelDownloadController {
  private readonly snapshots = new Map<string, ModelDownloadSnapshot>();
  private active: DownloadOperation | null = null;
  private operation: Promise<ModelDownloadSnapshot> | null = null;

  constructor(
    private readonly catalog: readonly LocalModelDefinition[],
    private readonly native: ModelFilePort,
    private readonly transfers: ModelTransferFactory,
    private readonly storage: ModelResumeStorage,
    private readonly changed: (snapshot: ModelDownloadSnapshot) => void,
  ) {
    for (const model of catalog) {
      this.snapshots.set(model.id, {
        modelId: model.id,
        phase: 'loading',
        bytesWritten: 0,
        canResume: false,
        verificationPending: false,
        file: null,
        error: null,
      });
    }
  }

  snapshot(id: string): ModelDownloadSnapshot {
    const value = this.snapshots.get(id);
    if (!value) {
      throw new Error('This model is not in the on-device catalog.');
    }
    return value;
  }

  async inspect(id: string): Promise<ModelDownloadSnapshot> {
    if (this.active?.model.id === id) {
      return this.snapshot(id);
    }
    const model = this.definition(id);
    try {
      const file = await this.checkedFile(model);
      if (file) {
        return this.publish(id, {
          phase: 'ready',
          bytesWritten: file.bytes,
          file,
          canResume: false,
          verificationPending: false,
          error: null,
        });
      }
      const paths = await this.native.getModelFilePaths(id);
      const raw = await this.storage.read(paths.resumeUri);
      const saved = raw === null ? null : parseSavedModelDownload(raw, model, paths.partialUri);
      return this.publish(id, {
        phase: saved || paths.verificationBytes !== null ? 'paused' : 'not_downloaded',
        bytesWritten: saved?.bytesWritten ?? paths.verificationBytes ?? 0,
        canResume: saved !== null,
        verificationPending: paths.verificationBytes !== null,
        file: null,
        error: null,
      });
    } catch (error) {
      this.publish(id, { phase: 'error', error: this.message(error) });
      throw error;
    }
  }

  download(id: string): Promise<ModelDownloadSnapshot> {
    return this.begin(id, 'download');
  }

  resume(id: string): Promise<ModelDownloadSnapshot> {
    return this.begin(id, 'resume');
  }

  verify(id: string): Promise<ModelDownloadSnapshot> {
    return this.begin(id, 'verify');
  }

  async pause(): Promise<void> {
    const context = this.active;
    if (!context || !this.operation) {
      return;
    }
    const alreadyRequested = context.pauseRequested;
    context.pauseRequested = true;
    if (!alreadyRequested && context.task?.state === 'active') {
      await context.task.pauseAsync();
    }
    await this.operation;
  }

  async cancel(): Promise<void> {
    const context = this.active;
    if (!context || !this.operation) {
      return;
    }
    context.cancelRequested = true;
    context.task?.cancel();
    await this.operation;
  }

  async remove(id: string): Promise<void> {
    this.definition(id);
    if (this.active?.model.id === id) {
      await this.cancel();
    }
    await this.native.removeModelFile(id);
    this.publish(id, {
      phase: 'not_downloaded',
      bytesWritten: 0,
      canResume: false,
      verificationPending: false,
      file: null,
      error: null,
    });
  }

  private begin(
    id: string,
    mode: 'download' | 'resume' | 'verify',
  ): Promise<ModelDownloadSnapshot> {
    if (this.active) {
      return Promise.reject(
        new Error('Pause the active model transfer before starting another one.'),
      );
    }
    const context: DownloadOperation = {
      model: this.definition(id),
      task: null,
      pauseRequested: false,
      cancelRequested: false,
      bytesWritten: 0,
      failure: null,
    };
    this.active = context;
    this.operation = this.perform(context, mode);
    return this.operation;
  }

  private async perform(
    context: DownloadOperation,
    mode: 'download' | 'resume' | 'verify',
  ): Promise<ModelDownloadSnapshot> {
    const { model } = context;
    try {
      this.publish(model.id, { phase: 'preparing', error: null });
      if (await this.checkedFile(model)) {
        throw new Error('This model is already installed. Remove it before downloading again.');
      }
      const paths = await this.native.getModelFilePaths(model.id);
      if (mode === 'verify') {
        if (paths.verificationBytes === null) {
          throw new Error('No completed download is waiting for verification.');
        }
        return await this.finish(context, paths.resumeUri);
      }
      return await this.transfer(context, paths, mode);
    } catch (error) {
      if (
        !context.failure &&
        (error instanceof ModelTransferCancelled ||
          (context.cancelRequested && context.task?.state === 'cancelled'))
      ) {
        return await this.discardCancelled(context);
      }
      const failure = context.failure ?? error;
      this.publish(model.id, { phase: 'error', error: this.message(failure) });
      throw failure;
    } finally {
      context.task?.release();
      if (this.active === context) {
        this.active = null;
        this.operation = null;
      }
    }
  }

  private async transfer(
    context: DownloadOperation,
    paths: LocalModelPaths,
    mode: 'download' | 'resume',
  ): Promise<ModelDownloadSnapshot> {
    const { model } = context;
    const saved = await this.savedDownload(model, paths.resumeUri, paths.partialUri, mode);
    context.bytesWritten = saved?.bytesWritten ?? 0;
    const remaining = model.bytes - context.bytesWritten;
    if (paths.availableBytes < remaining + DISK_RESERVE_BYTES) {
      throw new Error('Not enough free storage for this model download.');
    }
    if (paths.verificationBytes !== null) {
      throw new Error('Verify the pending model file or remove it before restarting its download.');
    }
    if (context.cancelRequested) {
      throw new ModelTransferCancelled('The model transfer was cancelled.');
    }
    if (context.pauseRequested) {
      return this.publish(model.id, { phase: 'paused', canResume: saved !== null });
    }
    const progress = (value: DownloadProgress) => this.progress(context, value);
    context.task = saved
      ? this.transfers.restore(saved.task, progress)
      : this.transfers.create(model.downloadUrl, paths.partialUri, progress);
    this.publish(model.id, {
      phase: 'downloading',
      bytesWritten: context.bytesWritten,
      canResume: false,
      verificationPending: false,
    });
    const file = await (saved ? context.task.resumeAsync() : context.task.downloadAsync());
    if (context.failure) {
      throw context.failure;
    }
    if (file === null) {
      return this.savePaused(context, paths.resumeUri, paths.partialUri);
    }
    return this.finish(context, paths.resumeUri);
  }

  private async finish(
    context: DownloadOperation,
    resumeUri: string,
  ): Promise<ModelDownloadSnapshot> {
    const { model } = context;
    this.publish(model.id, {
      phase: 'verifying',
      bytesWritten: model.bytes,
      canResume: false,
      verificationPending: true,
    });
    const file = this.validateFile(
      model,
      await this.native.finalizeModelDownload(model.id, model.sha256, model.bytes),
    );
    await this.storage.remove(resumeUri);
    return this.publish(model.id, {
      phase: 'ready',
      file,
      bytesWritten: model.bytes,
      canResume: false,
      verificationPending: false,
      error: null,
    });
  }

  private async savePaused(
    context: DownloadOperation,
    resumeUri: string,
    partialUri: string,
  ): Promise<ModelDownloadSnapshot> {
    if (!context.task) {
      throw new Error('The paused model transfer is unavailable.');
    }
    const state = context.task.savable();
    if (state.resumeData) {
      const saved: SavedModelDownload = {
        version: 1,
        modelId: context.model.id,
        sha256: context.model.sha256,
        bytesWritten: context.bytesWritten,
        task: state,
      };
      parseSavedModelDownload(JSON.stringify(saved), context.model, partialUri);
      await this.storage.write(resumeUri, JSON.stringify(saved));
    } else {
      await this.storage.remove(resumeUri);
    }
    return this.publish(context.model.id, {
      phase: 'paused',
      canResume: Boolean(state.resumeData),
      error: null,
    });
  }

  private async discardCancelled(context: DownloadOperation): Promise<ModelDownloadSnapshot> {
    const { model } = context;
    try {
      const file = await this.checkedFile(model);
      if (file) {
        return this.publish(model.id, {
          phase: 'ready',
          file,
          bytesWritten: model.bytes,
          canResume: false,
          verificationPending: false,
          error: null,
        });
      }
      await this.native.removeModelFile(model.id);
      return this.publish(model.id, {
        phase: 'not_downloaded',
        bytesWritten: 0,
        canResume: false,
        verificationPending: false,
        file: null,
        error: null,
      });
    } catch (error) {
      this.publish(model.id, { phase: 'error', error: this.message(error) });
      throw error;
    }
  }

  private progress(context: DownloadOperation, value: DownloadProgress): void {
    if (this.active !== context || context.pauseRequested || context.cancelRequested) {
      return;
    }
    if (
      !Number.isSafeInteger(value.bytesWritten) ||
      value.bytesWritten < 0 ||
      value.bytesWritten > context.model.bytes
    ) {
      context.failure = new Error('The model transfer size does not match the catalog.');
      context.task?.cancel();
      return;
    }
    context.bytesWritten = value.bytesWritten;
    this.publish(context.model.id, { bytesWritten: value.bytesWritten });
  }

  private async checkedFile(model: LocalModelDefinition): Promise<LocalModelFile | null> {
    const file = await this.native.getDownloadedModelFile(model.id);
    return file ? this.validateFile(model, file) : null;
  }

  private validateFile(model: LocalModelDefinition, file: LocalModelFile): LocalModelFile {
    if (file.id !== model.id || file.sha256 !== model.sha256 || file.bytes !== model.bytes) {
      throw new Error(
        'The installed model does not match the catalog. Remove it and download again.',
      );
    }
    return file;
  }

  private async savedDownload(
    model: LocalModelDefinition,
    uri: string,
    partialUri: string,
    mode: 'download' | 'resume',
  ): Promise<SavedModelDownload | null> {
    const raw = await this.storage.read(uri);
    if (mode === 'resume') {
      if (raw === null) {
        throw new Error('No resumable transfer is available. Restart this model download.');
      }
      return parseSavedModelDownload(raw, model, partialUri);
    }
    if (raw !== null) {
      throw new Error('A paused transfer exists. Resume it or remove it before restarting.');
    }
    return null;
  }

  private definition(id: string): LocalModelDefinition {
    const model = this.catalog.find((entry) => entry.id === id);
    if (!model) {
      throw new Error('This model is not in the on-device catalog.');
    }
    return model;
  }

  private publish(id: string, patch: Partial<ModelDownloadSnapshot>): ModelDownloadSnapshot {
    const snapshot = { ...this.snapshot(id), ...patch };
    this.snapshots.set(id, snapshot);
    this.changed(snapshot);
    return snapshot;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'The model download failed.';
  }
}
