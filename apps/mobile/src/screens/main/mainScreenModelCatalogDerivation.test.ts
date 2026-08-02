import { deriveModelCatalogState } from './mainScreenModelCatalogDerivation';
import type { ModelOption } from '../../api/types';

const MODELS: ModelOption[] = [
  {
    id: 'sonnet',
    name: 'Sonnet',
    isDefault: true,
    reasoningEffort: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
  } as unknown as ModelOption,
  {
    id: 'opus',
    name: 'Opus',
    reasoningEffort: ['high'],
    defaultReasoningEffort: 'high',
  } as unknown as ModelOption,
];

function derive(effortPickerModelId: string | null) {
  return deriveModelCatalogState({
    selectedChatId: null,
    selectionBelongsToCurrentChat: true,
    modelConfig: null,
    effortConfig: null,
    modeConfig: null,
    modelOptions: MODELS,
    preferredDefaultModelId: 'sonnet',
    preferredDefaultEffort: null,
    chatModelPreferencesRef: { current: {} },
    defaultServiceTier: null,
    selectedServiceTier: null,
    supportsFastMode: false,
    selectedAcpModeId: null,
    selectedCollaborationMode: 'default',
    effortPickerModelId,
    selectedModelId: null,
    selectedEffort: null,
  });
}

/**
 * The effort picker is opened for one specific model. An id that is not in the catalog means the
 * picker has nothing to show; silently falling back to the active model would offer that model's
 * efforts under another model's name.
 */
describe('The effort picker only ever describes the model it was opened for', () => {
  it('falls back to the active model when no model id is pinned', () => {
    const state = derive(null);
    expect(state.effortPickerModel?.id).toBe('sonnet');
    expect(state.effortPickerOptions).toEqual(['low', 'medium']);
    expect(state.effortPickerDefault).toBe('medium');
  });

  it('resolves a pinned model id that exists', () => {
    const state = derive('opus');
    expect(state.effortPickerModel?.id).toBe('opus');
    expect(state.effortPickerOptions).toEqual(['high']);
    expect(state.effortPickerDefault).toBe('high');
  });

  it('reports no picker model for an unknown pinned model id', () => {
    const state = derive('retired-model');
    expect(state.effortPickerModel).toBeNull();
    expect(state.effortPickerOptions).toEqual([]);
    expect(state.effortPickerDefault).toBeNull();
    expect(state.activeModel?.id).toBe('sonnet');
  });

  it('treats an empty pinned model id as unpinned', () => {
    const state = derive('');
    expect(state.effortPickerModel?.id).toBe('sonnet');
  });
});
