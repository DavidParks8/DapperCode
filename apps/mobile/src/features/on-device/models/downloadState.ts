import type { DownloadPauseState } from 'expo-file-system';
import { isRecord } from '@shared/records';
import type { LocalModelDefinition } from './types';

export interface SavedModelDownload {
  version: 1;
  modelId: string;
  sha256: string;
  bytesWritten: number;
  task: DownloadPauseState;
}

export function parseSavedModelDownload(
  raw: string,
  model: LocalModelDefinition,
  partialUri: string,
): SavedModelDownload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Paused download data is damaged. Restart this model download.');
    }
    throw error;
  }
  if (
    !isRecord(parsed) ||
    parsed['version'] !== 1 ||
    parsed['modelId'] !== model.id ||
    parsed['sha256'] !== model.sha256 ||
    typeof parsed['bytesWritten'] !== 'number' ||
    !Number.isSafeInteger(parsed['bytesWritten']) ||
    parsed['bytesWritten'] < 0 ||
    parsed['bytesWritten'] > model.bytes
  ) {
    throw new Error('Paused download data does not match this model. Restart its download.');
  }
  return {
    version: 1,
    modelId: model.id,
    sha256: model.sha256,
    bytesWritten: parsed['bytesWritten'],
    task: resumeTask(parsed['task'], model, partialUri),
  };
}

function resumeTask(
  value: unknown,
  model: LocalModelDefinition,
  partialUri: string,
): DownloadPauseState {
  if (!isRecord(value)) {
    throw new Error('Paused download task data is invalid. Restart its download.');
  }
  const task = value;
  if (
    task['url'] !== model.downloadUrl ||
    task['fileUri'] !== partialUri ||
    task['isDirectory'] !== false ||
    typeof task['resumeData'] !== 'string' ||
    !task['resumeData'] ||
    (task['headers'] !== undefined &&
      (!isRecord(task['headers']) || Object.keys(task['headers']).length !== 0))
  ) {
    throw new Error('Paused download origin or destination is invalid. Restart this download.');
  }
  return {
    url: model.downloadUrl,
    fileUri: partialUri,
    isDirectory: false,
    resumeData: task['resumeData'],
  };
}
