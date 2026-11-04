import {
  LOCAL_MODEL_CATALOG,
  LOCAL_MODEL_FAMILIES,
  localModelDefinition,
  requireLocalModelRuntime,
} from './catalog';
import { modelMemoryBytes } from './memory';

test('modern families expose real pinned quant choices while existing model identities remain valid', () => {
  expect(LOCAL_MODEL_FAMILIES.map((family) => family.name)).toEqual(
    expect.arrayContaining(['Bonsai 2', 'Qwen3.5', 'Gemma 4']),
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

test('catalog licenses use one SPDX casing and family copy never refers to another page', () => {
  for (const model of LOCAL_MODEL_CATALOG) {
    expect(model.license).toBe('Apache-2.0');
  }
  for (const family of LOCAL_MODEL_FAMILIES) {
    expect(family.description).not.toMatch(/next page/i);
  }
});
