import { modelOptionsFromAcpConfig } from './chatState';

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
