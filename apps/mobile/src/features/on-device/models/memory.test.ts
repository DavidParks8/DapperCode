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
  // The floor compares a device's advertised RAM class (whole GiB) with the catalog minimum.
  const below = (Math.ceil(model.minimumDeviceBytes / 1024 ** 3) - 1) * 1024 ** 3;
  expect(modelMemoryAdmission(model, { ...memory, physicalBytes: below }).status).toBe(
    'unsupported',
  );
  expect(modelMemoryAdmission(model, { ...memory, physicalBytes: below + 1 }).status).toBe('ready');
});

// iOS reports physical memory below the advertised RAM (the GPU and system carve-outs), so a
// marketed "8 GB" iPhone never reports a full 8 GiB.
const GiB = 1024 ** 3;
const ample = 64 * GiB;
test.each([
  ['gemma-4-e2b-q4-0', 'an 8 GB iPhone', Math.round(7.42 * GiB), 'ready'],
  ['gemma-4-e2b-q4-0', 'an 8 GB iPhone', 8 * GiB - 1, 'ready'],
  ['gemma-4-e2b-q8-0', 'a 12 GB iPhone', Math.round(11.16 * GiB), 'ready'],
  ['gemma-4-e2b-q4-0', 'a 6 GB iPhone', Math.round(5.57 * GiB), 'unsupported'],
  ['gemma-4-e2b-q8-0', 'an 8 GB iPhone', Math.round(7.42 * GiB), 'unsupported'],
  ['bonsai-2-2b-q2-0', 'a 4 GB iPhone', Math.round(3.7 * GiB), 'ready'],
])('%s on %s reporting reduced physical memory is %s', (id, _device, physicalBytes, status) => {
  const candidate = localModelDefinition(id);
  const device = { physicalBytes, availableBytes: ample, isSimulator: false };
  expect(modelMemoryAdmission(candidate, device).status).toBe(status);
});

test('the advertised-class floor never admits a model the raw RAM cannot hold', () => {
  const candidate = localModelDefinition('gemma-4-e2b-q4-0');
  const tiny = {
    physicalBytes: modelMemoryBytes(candidate) - 1,
    availableBytes: ample,
    isSimulator: false,
  };
  expect(modelMemoryAdmission(candidate, tiny).status).toBe('unsupported');
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
    } else if (entry.family === 'LFM3') {
      expect(entry.kvBytesPerToken).toBe(2 * 11 * 4 * 128 * 2);
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

test.each(LOCAL_MODEL_CATALOG)(
  '$id grows beyond 16K within its native context and memory limits',
  (entry) => {
    const maximum = entry.family === 'Qwen3' ? 40960 : entry.family === 'Gemma 4' ? 131072 : 262144;
    expect(entry.maxContextTokens).toBe(maximum);
    const tiers = [4096, 8192, 16384, 32768, 65536, 131072, 262144].filter(
      (tokens) => tokens < maximum,
    );
    tiers.push(maximum);
    for (const [index, tokens] of tiers.entries()) {
      const headroom = modelMemoryBytes(entry, tokens);
      expect(
        modelContextTokens(entry, { ...memory, physicalBytes: ample, availableBytes: headroom }),
      ).toBe(tokens);
      expect(
        modelContextTokens(entry, {
          ...memory,
          physicalBytes: ample,
          availableBytes: headroom - 1,
        }),
      ).toBe(tiers[Math.max(0, index - 1)]);
    }
    expect(
      modelContextTokens(entry, { ...memory, physicalBytes: ample, availableBytes: ample }),
    ).toBe(maximum);
  },
);

test('reported headroom cannot grow a context beyond physical device RAM', () => {
  expect(
    modelContextTokens(model, {
      ...memory,
      physicalBytes: 4 * GiB,
      availableBytes: ample,
    }),
  ).toBe(16384);
});
