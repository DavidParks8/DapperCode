import { DownloadTask, File } from 'expo-file-system';
import type { DownloadPauseState, DownloadProgress, DownloadTaskState } from 'expo-file-system';
import { deleteFileIfPresent, readFileInfo, writeFile } from '@shared/filesystem';

export interface ModelTransfer {
  readonly state: DownloadTaskState;
  downloadAsync(): Promise<{ uri: string } | null>;
  resumeAsync(): Promise<{ uri: string } | null>;
  pauseAsync(): Promise<void>;
  cancel(): void;
  savable(): DownloadPauseState;
  release(): void;
}

export interface ModelTransferFactory {
  create(url: string, uri: string, progress: (value: DownloadProgress) => void): ModelTransfer;
  restore(state: DownloadPauseState, progress: (value: DownloadProgress) => void): ModelTransfer;
}

export interface ModelResumeStorage {
  read(uri: string): Promise<string | null>;
  write(uri: string, value: string): Promise<void>;
  remove(uri: string): Promise<void>;
}

export const expoModelTransfers: ModelTransferFactory = {
  create: (url, uri, onProgress) =>
    new DownloadTask(url, new File(uri), { sessionType: 'foreground', onProgress }),
  restore: (state, onProgress) =>
    DownloadTask.fromSavable(state, { sessionType: 'foreground', onProgress }),
};

export const modelResumeStorage: ModelResumeStorage = {
  read: async (uri) => {
    const file = new File(uri);
    return (await readFileInfo(file)).exists ? file.text() : null;
  },
  write: (uri, value) => writeFile(new File(uri), value),
  remove: (uri) => deleteFileIfPresent(new File(uri)),
};
