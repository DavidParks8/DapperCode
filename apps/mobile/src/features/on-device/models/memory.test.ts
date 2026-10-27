import { LOCAL_MODEL_CATALOG, localModelDefinition } from './catalog';
import {
  MODEL_MEMORY_RESERVE_BYTES,
  modelMemoryAdmission,
  modelMemoryBytes,
  requireModelMemory,
} from './memory';

const model = localModelDefinition('qwen3-1.7b-q4-k-m');
const required = modelMemoryBytes(model);
const memory = { physicalBytes: 8 * 1024 ** 3, availableBytes: required, isSimulator: false };

test('RAM estimates include weights, full FP16 KV cache, working buffers, and reserve', () => {
  expect(required).toBe(1282439264 + 114688 * 4096 + 268435456 + MODEL_MEMORY_RESERVE_BYTES);
});

test('the exact admission boundary is inclusive and one byte below is refused', () => {
  expect(modelMemoryAdmission(model, memory).status).toBe('ready');
  expect(modelMemoryAdmission(model, { ...memory, availableBytes: required - 1 }).status).toBe(
    'memory_pressure',
  );
  expect(() => requireModelMemory(model, { ...memory, availableBytes: required - 1 })).toThrow(
    'Not enough app memory',
  );
});

test('physical RAM and app headroom are separate constraints', () => {
  expect(
    modelMemoryAdmission(model, { ...memory, physicalBytes: model.minimumDeviceBytes - 1 }).status,
  ).toBe('unsupported');
  expect(
    modelMemoryAdmission(model, { ...memory, physicalBytes: model.minimumDeviceBytes }).status,
  ).toBe('ready');
});

test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'unavailable native headroom %s is never replaced with a total-RAM guess',
  (availableBytes) => {
    expect(modelMemoryAdmission(model, { ...memory, availableBytes }).status).toBe('unavailable');
  },
);

test('admission is stateless across changing native readings', () => {
  expect(modelMemoryAdmission(model, { ...memory, availableBytes: required - 1 }).status).toBe(
    'memory_pressure',
  );
  expect(modelMemoryAdmission(model, { ...memory, availableBytes: required + 1 }).status).toBe(
    'ready',
  );
});

test('simulator admission never claims verified phone compatibility', () => {
  expect(modelMemoryAdmission(model, { ...memory, isSimulator: true }).message).toContain(
    'not verified',
  );
});

test('the offline catalog contains distinct immutable verified artifact identities', () => {
  expect(LOCAL_MODEL_CATALOG.length).toBeGreaterThanOrEqual(3);
  expect(new Set(LOCAL_MODEL_CATALOG.map((entry) => entry.id)).size).toBe(
    LOCAL_MODEL_CATALOG.length,
  );
  for (const entry of LOCAL_MODEL_CATALOG) {
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(entry.downloadUrl).toMatch(
      /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\//u,
    );
    expect(entry.bytes).toBeGreaterThan(0);
    expect(entry.kvBytesPerToken).toBe(
      entry.id.startsWith('qwen3-4b') ? 2 * 36 * 8 * 128 * 2 : 2 * 28 * 8 * 128 * 2,
    );
  }
  expect(() => localModelDefinition('../custom-model')).toThrow('not in the on-device catalog');
});
