import { LOCAL_MODEL_CATALOG, localModelDefinition } from './catalog';
import {
  MODEL_MEMORY_RESERVE_BYTES,
  modelContextTokens,
  modelMemoryAdmission,
  modelMemoryBytes,
  requireModelMemory,
  residentModelBytes,
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
    if (entry.family === 'Qwen3') {
      expect(entry.kvBytesPerToken).toBe(
        entry.id.startsWith('qwen3-4b') ? 2 * 36 * 8 * 128 * 2 : 2 * 28 * 8 * 128 * 2,
      );
    } else if (entry.family === 'Gemma 4') {
      expect(entry.kvBytesPerToken).toBe(4 * (28 * 256 + 7 * 512));
    } else {
      const fullAttentionLayers = entry.parameters === '4B' ? 8 : 6;
      const kvHeads = entry.parameters === '4B' ? 4 : 2;
      expect(entry.kvBytesPerToken).toBe(2 * fullAttentionLayers * kvHeads * 256 * 2);
    }
  }
  expect(() => localModelDefinition('../custom-model')).toThrow('not in the on-device catalog');
});

test('switching models credits memory the resident model releases before loading', () => {
  const resident = { model: localModelDefinition('qwen3-0.6b-q4-0'), contextTokens: 8192 };
  const tight = { ...memory, availableBytes: required - 1 };
  expect(modelMemoryAdmission(model, tight).status).toBe('memory_pressure');
  const switching = modelMemoryAdmission(model, tight, resident);
  expect(switching).toMatchObject({
    status: 'ready',
    unloadsResident: true,
    releasableBytes: residentModelBytes(resident),
  });
  expect(switching.message).toContain('unloads Qwen3 0.6B');
  expect(modelMemoryAdmission(model, memory, resident)).toMatchObject({
    status: 'ready',
    unloadsResident: false,
  });
  expect(
    modelMemoryAdmission(
      model,
      { ...memory, availableBytes: required - residentModelBytes(resident) - 1 },
      resident,
    ).status,
  ).toBe('memory_pressure');
});

test('loaded context grows to the catalog maximum only when fresh headroom allows it', () => {
  expect(model.maxContextTokens).toBeGreaterThan(model.contextTokens);
  expect(modelContextTokens(model, memory)).toBe(model.contextTokens);
  expect(
    modelContextTokens(model, {
      ...memory,
      availableBytes: modelMemoryBytes(model, model.maxContextTokens),
    }),
  ).toBe(model.maxContextTokens);
  for (const entry of LOCAL_MODEL_CATALOG) {
    expect(entry.contextTokens).toBeGreaterThanOrEqual(4096);
    expect(entry.maxContextTokens).toBeGreaterThanOrEqual(entry.contextTokens);
  }
});
