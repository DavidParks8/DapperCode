import { deriveModelCatalogState } from './catalogDerivation';
import type { ModelOption } from '@bridge/types/types';

const MODELS: ModelOption[] = [
  {
    id: 'sonnet',
    displayName: 'Sonnet',
    isDefault: true,
    reasoningEffort: ['low', 'medium'],
    defaultReasoningEffort: 'medium',
  } as unknown as ModelOption,
  {
    id: 'opus',
    displayName: 'Opus',
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

describe('optimistic ACP config values', () => {
  it('prioritizes pending model and effort values over the last server snapshot', () => {
    const state = deriveModelCatalogState({
      selectedChatId: 'thread-1',
      selectionBelongsToCurrentChat: true,
      modelConfig: { id: 'model', category: 'model', value: 'sonnet' },
      effortConfig: { id: 'effort', category: 'thought_level', value: 'medium' },
      modeConfig: null,
      modelOptions: MODELS,
      preferredDefaultModelId: null,
      preferredDefaultEffort: null,
      chatModelPreferencesRef: { current: {} },
      defaultServiceTier: null,
      selectedServiceTier: null,
      supportsFastMode: false,
      selectedAcpModeId: null,
      selectedCollaborationMode: 'default',
      effortPickerModelId: 'opus',
      selectedModelId: null,
      selectedEffort: null,
      pendingAcpConfig: {
        model: { value: 'opus', revision: 1 },
        thought_level: { value: 'high', revision: 2 },
      },
    });

    expect(state.activeModelId).toBe('opus');
    expect(state.activeModelLabel).toBe('Opus');
    expect(state.activeEffort).toBe('high');
    expect(state.activeEffortLabel).toBe('High');
  });

  it('uses a pending mode label until the server snapshot catches up', () => {
    const state = deriveModelCatalogState({
      selectedChatId: 'thread-1',
      selectionBelongsToCurrentChat: true,
      modelConfig: null,
      effortConfig: null,
      modeConfig: {
        id: 'mode',
        category: 'mode',
        value: 'build',
        options: [
          { value: 'build', name: 'Build' },
          { value: 'plan', name: 'Plan' },
        ],
      },
      modelOptions: MODELS,
      preferredDefaultModelId: null,
      preferredDefaultEffort: null,
      chatModelPreferencesRef: { current: {} },
      defaultServiceTier: null,
      selectedServiceTier: null,
      supportsFastMode: false,
      selectedAcpModeId: 'plan',
      selectedCollaborationMode: 'plan',
      effortPickerModelId: null,
      selectedModelId: null,
      selectedEffort: null,
      pendingAcpConfig: {
        mode: { value: 'plan', revision: 1 },
      },
    });

    expect(state.collaborationModeLabel).toBe('Plan');
  });
});
