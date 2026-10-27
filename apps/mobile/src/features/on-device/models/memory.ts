import type { DeviceMemory, LocalModelDefinition } from './types';

export const MODEL_MEMORY_RESERVE_BYTES = 384 * 1024 * 1024;

export interface ModelMemoryAdmission {
  status: 'ready' | 'unsupported' | 'memory_pressure' | 'unavailable';
  requiredBytes: number;
  message: string;
}

export function modelMemoryBytes(model: LocalModelDefinition): number {
  return (
    model.bytes +
    model.kvBytesPerToken * model.contextTokens +
    model.workingBytes +
    MODEL_MEMORY_RESERVE_BYTES
  );
}

export function modelMemoryAdmission(
  model: LocalModelDefinition,
  memory: DeviceMemory,
): ModelMemoryAdmission {
  const requiredBytes = modelMemoryBytes(model);
  if (
    !Number.isSafeInteger(memory.physicalBytes) ||
    !Number.isSafeInteger(memory.availableBytes) ||
    memory.physicalBytes <= 0 ||
    memory.availableBytes <= 0
  ) {
    return {
      status: 'unavailable',
      requiredBytes,
      message: 'iOS memory headroom is unavailable. Close other apps and refresh before loading.',
    };
  }
  if (memory.physicalBytes < model.minimumDeviceBytes || memory.physicalBytes < requiredBytes) {
    return {
      status: 'unsupported',
      requiredBytes,
      message: 'This model exceeds the conservative RAM budget for this device.',
    };
  }
  if (memory.availableBytes < requiredBytes) {
    return {
      status: 'memory_pressure',
      requiredBytes,
      message:
        'Not enough app memory is currently available. Unload the active model or choose a smaller one.',
    };
  }
  return {
    status: 'ready',
    requiredBytes,
    message: memory.isSimulator
      ? 'Fits estimated simulator host headroom. Physical iPhone compatibility is not verified.'
      : 'Fits the current estimated app memory budget. iOS memory limits can change.',
  };
}

export function requireModelMemory(model: LocalModelDefinition, memory: DeviceMemory): void {
  const admission = modelMemoryAdmission(model, memory);
  if (admission.status !== 'ready') {
    throw new Error(admission.message);
  }
}
