import renderer, { act } from 'react-test-renderer';
import { useMainScreenPickerOptionBuilders } from './pickerOptionBuilders';
import type { MainScreenPickerOptionBuildersContext } from './pickerOptionBuilders';
import { createTestStore, withAppStore } from '@shell/state/testing';
import type { AppStore } from '@shell/state/types';
import type { ModelOption } from '@bridge/types/types';

jest.mock('@shared/feedback', () => ({
  feedback: {
    selection: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue(undefined),
    success: jest.fn().mockResolvedValue(undefined),
    warning: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    destructive: jest.fn().mockResolvedValue(undefined),
  },
}));

import { feedback } from '@shared/feedback';

const mockFeedback = feedback as unknown as { selection: jest.Mock };

const model: ModelOption = {
  id: 'gpt-a',
  displayName: 'GPT A',
  providerId: 'openai',
  isDefault: false,
  reasoningEffort: [{ effort: 'low' }, { effort: 'high' }],
  defaultReasoningEffort: undefined,
};

function createContext(
  overrides: Partial<MainScreenPickerOptionBuildersContext> = {},
): MainScreenPickerOptionBuildersContext {
  return {
    activeAgentId: 'codex',
    activeEffort: null,
    applyAcpConfigOption: jest.fn().mockResolvedValue(true),
    effectiveModelId: null,
    effortConfig: null,
    effortPickerDefault: undefined,
    effortPickerModel: null,
    effortPickerOptions: [{ effort: 'high', description: undefined }],
    modeConfig: null,
    modelConfig: { value: '' },
    modelOptions: [model],
    readyAgents: [],
    selectEffort: jest.fn().mockResolvedValue(undefined),
    selectModel: jest.fn().mockResolvedValue(undefined),
    selectPendingAgent: jest.fn(),
    serverDefaultModel: undefined,
    selectedChatId: null,
    supportsPlanMode: true,
    ...overrides,
  } as unknown as MainScreenPickerOptionBuildersContext;
}

function Harness({
  context,
  resultRef,
}: {
  context: MainScreenPickerOptionBuildersContext;
  resultRef: { current: ReturnType<typeof useMainScreenPickerOptionBuilders> | null };
}) {
  resultRef.current = useMainScreenPickerOptionBuilders(context);
  return null;
}

function render(context: MainScreenPickerOptionBuildersContext) {
  const store: AppStore = createTestStore();
  const resultRef: { current: ReturnType<typeof useMainScreenPickerOptionBuilders> | null } = {
    current: null,
  };
  act(() => {
    renderer.create(withAppStore(store, <Harness context={context} resultRef={resultRef} />));
  });
  if (!resultRef.current) {
    throw new Error('Hook did not render');
  }
  return resultRef.current;
}

describe('useMainScreenPickerOptionBuilders selection haptics', () => {
  beforeEach(() => {
    mockFeedback.selection.mockClear();
  });

  it('fires a selection haptic and delegates when a model option is pressed', async () => {
    const context = createContext();
    const result = render(context);
    const modelOption = result.modelPickerOptions.find((option) => option.key === model.id);
    expect(modelOption).toBeDefined();

    await act(async () => {
      modelOption!.onPress();
    });

    expect(mockFeedback.selection).toHaveBeenCalledTimes(1);
    expect(context.selectModel).toHaveBeenCalledWith(model.id);
  });

  it('does not label model rows with the default reasoning effort', () => {
    const context = createContext({
      modelOptions: [{ ...model, defaultReasoningEffort: 'max' }],
    });
    const result = render(context);
    const modelOption = result.modelPickerOptions.find((option) => option.key === model.id);

    // The trailing effort label read as a property of the model rather than a setting, so it was
    // meaningless next to the name and context size.
    expect(modelOption).toBeDefined();
    expect(modelOption!.meta).toBeUndefined();
  });

  it('fires a selection haptic and delegates when the server-default model option is pressed', async () => {
    const context = createContext();
    const result = render(context);
    const defaultOption = result.modelPickerOptions.find(
      (option) => option.key === 'server-default',
    );
    expect(defaultOption).toBeDefined();

    await act(async () => {
      defaultOption!.onPress();
    });

    expect(mockFeedback.selection).toHaveBeenCalledTimes(1);
    expect(context.selectModel).toHaveBeenCalledWith(null);
  });

  it('fires a selection haptic and delegates when an effort option is pressed', async () => {
    const context = createContext();
    const result = render(context);
    const effortOption = result.effortPickerSheetOptions.find((option) => option.key === 'high');
    expect(effortOption).toBeDefined();

    await act(async () => {
      effortOption!.onPress();
    });

    expect(mockFeedback.selection).toHaveBeenCalledTimes(1);
    expect(context.selectEffort).toHaveBeenCalledWith('high');
  });

  it('fires a selection haptic and delegates immediately when an agent option is pressed', () => {
    const selectPendingAgent = jest.fn();
    const context = createContext({
      readyAgents: [
        {
          agentId: 'claude',
          displayName: 'Claude',
          version: '1.0.0',
          provenance: 'test',
          lifecycle: 'ready',
        },
      ],
      selectPendingAgent,
    });
    const result = render(context);
    const agentOption = result.agentPickerOptions.find((option) => option.key === 'claude');
    expect(agentOption).toBeDefined();

    act(() => {
      agentOption!.onPress();
    });

    expect(mockFeedback.selection).toHaveBeenCalledTimes(1);
    expect(selectPendingAgent).toHaveBeenCalledWith('claude');
  });

  it('fires a selection haptic when a collaboration mode option is pressed', async () => {
    const context = createContext();
    const result = render(context);
    const defaultModeOption = result.collaborationModeOptions.find(
      (option) => option.key === 'default',
    );
    expect(defaultModeOption).toBeDefined();

    await act(async () => {
      defaultModeOption!.onPress();
    });

    expect(mockFeedback.selection).toHaveBeenCalledTimes(1);
  });
});
