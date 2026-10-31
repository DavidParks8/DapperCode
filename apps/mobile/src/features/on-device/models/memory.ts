import type { DeviceMemory, LocalModelDefinition } from './types';

export const MODEL_MEMORY_RESERVE_BYTES = 384 * 1024 * 1024;

export interface ModelMemoryAdmission {
  status: 'ready' | 'unsupported' | 'memory_pressure' | 'unavailable';
  requiredBytes: number;
  /** Bytes credited because loading first releases the currently resident model. */
  releasableBytes: number;
  /** True when the model fits only because the resident model is released first. */
  unloadsResident: boolean;
  message: string;
}

/** A model context that is currently resident and is released before another load. */
export interface ResidentModel {
  model: LocalModelDefinition;
  contextTokens: number;
}

export function modelMemoryBytes(
  model: LocalModelDefinition,
  contextTokens = model.contextTokens,
): number {
  return residentBytes(model, contextTokens) + MODEL_MEMORY_RESERVE_BYTES;
}

function residentBytes(model: LocalModelDefinition, contextTokens: number): number {
  return (
    model.bytes + model.kvBytesPerToken * contextTokens + model.workingBytes + model.stateCacheBytes
  );
}

/** Estimated memory returned to the app when a resident context is released. */
export function residentModelBytes(resident: ResidentModel): number {
  return residentBytes(resident.model, resident.contextTokens);
}

function validMemory(memory: DeviceMemory): boolean {
  return (
    Number.isSafeInteger(memory.physicalBytes) &&
    Number.isSafeInteger(memory.availableBytes) &&
    memory.physicalBytes > 0 &&
    memory.availableBytes > 0
  );
}

export function modelMemoryAdmission(
  model: LocalModelDefinition,
  memory: DeviceMemory,
  resident: ResidentModel | null = null,
): ModelMemoryAdmission {
  const requiredBytes = modelMemoryBytes(model);
  if (!validMemory(memory)) {
    return {
      status: 'unavailable',
      requiredBytes,
      releasableBytes: 0,
      unloadsResident: false,
      message: 'iOS memory headroom is unavailable. Close other apps and refresh before loading.',
    };
  }
  if (memory.physicalBytes < model.minimumDeviceBytes || memory.physicalBytes < requiredBytes) {
    return {
      status: 'unsupported',
      requiredBytes,
      releasableBytes: 0,
      unloadsResident: false,
      message: 'This model exceeds the conservative RAM budget for this device.',
    };
  }
  const releasableBytes = resident ? residentModelBytes(resident) : 0;
  if (memory.availableBytes + releasableBytes < requiredBytes) {
    return {
      status: 'memory_pressure',
      requiredBytes,
      releasableBytes,
      unloadsResident: false,
      message: resident
        ? 'Not enough app memory is available even after unloading the current model. Close other apps or choose a smaller model.'
        : 'Not enough app memory is currently available. Close other apps or choose a smaller model.',
    };
  }
  const unloadsResident = Boolean(resident) && memory.availableBytes < requiredBytes;
  const switching =
    resident && unloadsResident
      ? ` Loading first unloads ${resident.model.name} ${resident.model.quantization}.`
      : '';
  return {
    status: 'ready',
    requiredBytes,
    releasableBytes,
    unloadsResident,
    message:
      (memory.isSimulator
        ? 'Fits estimated simulator host headroom. Physical iPhone compatibility is not verified.'
        : 'Fits the current estimated app memory budget. iOS memory limits can change.') +
      switching,
  };
}

export function requireModelMemory(model: LocalModelDefinition, memory: DeviceMemory): void {
  const admission = modelMemoryAdmission(model, memory);
  if (admission.status !== 'ready') {
    throw new Error(admission.message);
  }
}

/**
 * Chooses the largest supported context, halving from the catalog maximum, whose KV cache fits the
 * measured headroom. Never returns less than the admitted minimum.
 */
export function modelContextTokens(model: LocalModelDefinition, memory: DeviceMemory): number {
  let tokens = Math.max(model.maxContextTokens, model.contextTokens);
  while (tokens > model.contextTokens) {
    if (validMemory(memory) && memory.availableBytes >= modelMemoryBytes(model, tokens)) {
      return tokens;
    }
    tokens = Math.max(model.contextTokens, Math.floor(tokens / 2));
  }
  return model.contextTokens;
}
