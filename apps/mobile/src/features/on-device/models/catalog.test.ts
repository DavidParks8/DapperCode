import {
  LOCAL_MODEL_CATALOG,
  LOCAL_MODEL_FAMILIES,
  localModelDefinition,
  requireLocalModelRuntime,
} from './catalog';
import { modelContextTokens, modelMemoryAdmission, modelMemoryBytes } from './memory';

test('modern families expose real pinned quant choices while existing model identities remain valid', () => {
  expect(LOCAL_MODEL_FAMILIES.map((family) => family.name)).toEqual(
    expect.arrayContaining(['Bonsai 2', 'Qwen3.5', 'Gemma 4', 'LFM3']),
  );
  expect(new Set(LOCAL_MODEL_CATALOG.map((model) => model.id)).size).toBe(
    LOCAL_MODEL_CATALOG.length,
  );
  for (const model of LOCAL_MODEL_CATALOG) {
    expect(model.id).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
    expect(model.downloadUrl).toMatch(
      /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\/[^/]+\.gguf$/,
    );
    expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(model.bytes).toBeGreaterThan(0);
    expect(model.minimumDeviceBytes).toBeGreaterThanOrEqual(modelMemoryBytes(model));
  }
  expect(localModelDefinition('qwen3-1.7b-q4-k-m').sha256).toBe(
    'd2387ca2dbfee2ffabce7120d3770dadca0b293052bc2f0e138fdc940d9bc7b5',
  );
});

test('unsupported ternary packings fail explicitly instead of reaching native inference', () => {
  const unsupported = LOCAL_MODEL_CATALOG.filter((model) => model.runtimeIssue);
  expect(unsupported).toHaveLength(4);
  for (const model of unsupported) {
    expect(() => requireLocalModelRuntime(model)).toThrow('PrismML-specific runtime');
  }
  expect(() => requireLocalModelRuntime(localModelDefinition('bonsai-2-2b-q2-0'))).not.toThrow();
});

test('LFM3 offers pinned text quants with hybrid-state memory admission', () => {
  const models = LOCAL_MODEL_CATALOG.filter((model) => model.family === 'LFM3');
  expect(models.map((model) => model.quantization)).toEqual(['Q4_K_M', 'Q5_K_M', 'Q8_0']);
  const memory = {
    physicalBytes: 4 * 1024 ** 3,
    availableBytes: 3.5 * 1024 ** 3,
    isSimulator: false,
  };
  for (const model of models) {
    expect(model.sourceUrl).toBe('https://huggingface.co/LiquidAI/LFM3-1.7B-GGUF');
    expect(model.downloadUrl).toContain('/resolve/cd0c74c575b5c416f3011b5b4c298077f26ca8c2/');
    expect(model.license).toBe('LFM Open License v1.0');
    expect(model.contextTokens).toBe(4096);
    expect(model.maxContextTokens).toBe(262144);
    // Eleven attention layers, four KV heads, 128 dimensions, K+V in FP16.
    expect(model.kvBytesPerToken).toBe(11 * 4 * 128 * 2 * 2);
    expect(model.stateCacheBytes).toBe(128 * 1024 ** 2);
    expect(modelMemoryAdmission(model, memory).status).toBe('ready');
    expect(
      modelContextTokens(model, { ...memory, availableBytes: modelMemoryBytes(model, 32768) }),
    ).toBe(32768);
    expect(
      modelMemoryAdmission(model, { ...memory, availableBytes: modelMemoryBytes(model) - 1 })
        .status,
    ).toBe('memory_pressure');
    expect(() => requireLocalModelRuntime(model)).not.toThrow();
  }
  expect(localModelDefinition('lfm3-1.7b-q4-k-m').sha256).toBe(
    '3793e1e6e2266919d6e015287221b41100175a98eddaba92e111aed3b05c93c4',
  );
});

test('catalog licenses retain publisher terms and family copy never refers to another page', () => {
  for (const model of LOCAL_MODEL_CATALOG) {
    expect(model.license).toBe(model.family === 'LFM3' ? 'LFM Open License v1.0' : 'Apache-2.0');
  }
  for (const family of LOCAL_MODEL_FAMILIES) {
    expect(family.description).not.toMatch(/next page/i);
  }
});
