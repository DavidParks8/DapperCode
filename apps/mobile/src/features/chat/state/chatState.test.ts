import { mergeModelOptions, modelOptionsFromAcpConfig } from './chatState';

describe('modelOptionsFromAcpConfig', () => {
  it('does not reinterpret the effective ACP model as the server default', () => {
    const options = modelOptionsFromAcpConfig([
      {
        id: 'model',
        category: 'model',
        value: 'provider/active',
        options: [
          { value: 'provider/active', name: 'Provider/Active' },
          { value: 'provider/other', name: 'Provider/Other' },
        ],
      },
    ]);

    expect(options.map((option) => option.isDefault)).toEqual([undefined, undefined]);
  });
});

describe('mergeModelOptions', () => {
  it('keeps the catalog description when the chat config option has none', () => {
    const merged = mergeModelOptions(
      [{ id: 'local-a', displayName: 'Local A', description: 'Loaded · 16K context' }],
      [{ id: 'local-a', displayName: 'Local A', description: undefined }],
    );
    expect(merged[0]?.description).toBe('Loaded · 16K context');
    const configured = mergeModelOptions(
      [{ id: 'm', displayName: 'M', description: 'Catalog' }],
      [{ id: 'm', displayName: 'M', description: 'Agent' }],
    );
    expect(configured[0]?.description).toBe('Agent');
  });
});
