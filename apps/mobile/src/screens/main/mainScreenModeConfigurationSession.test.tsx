import renderer, { act } from 'react-test-renderer';
import { useMainScreenModeConfigurationSession } from './mainScreenModeConfigurationSession';
import type { MainScreenModeConfigurationSessionContext } from './mainScreenModeConfigurationSession';
import { errorAtom } from '../../state/mainScreen/turn';
import { modelOptionsByAgentAtom, loadingModelsAtom } from '../../state/mainScreen/models';
import { createTestStore, withAppStore } from '../../state/testing';
import type { AppStore } from '../../state/types';
import type { ModelOption } from '../../api/types';

const cachedModel: ModelOption = {
  id: 'gpt-cached',
  displayName: 'Cached model',
  providerId: 'openai',
  isDefault: false,
  reasoningEffort: [],
  defaultReasoningEffort: undefined,
};

function createContext(listModelOptions: jest.Mock): MainScreenModeConfigurationSessionContext {
  return {
    activeAgentId: 'codex',
    activeModelId: null,
    effectiveModelId: null,
    activeServiceTier: null,
    api: { listModelOptions },
    chatModelPreferencesRef: { current: {} },
    effortConfig: null,
    modelOptionsRequestRef: { current: 0 },
    rememberChatModelPreference: jest.fn(),
    saveChatModelPreferences: jest.fn(),
    selectedChatId: null,
    selectedChatRef: { current: null },
    setSelectedChat: jest.fn(),
  } as unknown as MainScreenModeConfigurationSessionContext;
}

function Harness({
  context,
  resultRef,
}: {
  context: MainScreenModeConfigurationSessionContext;
  resultRef: { current: ReturnType<typeof useMainScreenModeConfigurationSession> | null };
}) {
  resultRef.current = useMainScreenModeConfigurationSession(context);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useMainScreenModeConfigurationSession refreshModelOptions', () => {
  it('does not set a global error and keeps cached models when a silent/background refresh fails', async () => {
    const store: AppStore = createTestStore();
    store.set(modelOptionsByAgentAtom, { codex: [cachedModel] });
    const listModelOptions = jest.fn().mockRejectedValue(new Error('offline'));
    const context = createContext(listModelOptions);
    const resultRef: { current: ReturnType<typeof useMainScreenModeConfigurationSession> | null } =
      { current: null };

    await act(async () => {
      renderer.create(withAppStore(store, <Harness context={context} resultRef={resultRef} />));
    });

    await act(async () => {
      await resultRef.current?.refreshModelOptions({ silent: true });
    });
    await flush();

    expect(store.get(errorAtom)).toBeNull();
    expect(store.get(loadingModelsAtom)).toBe(false);
    // The previously cached models for this agent must still be usable.
    expect(store.get(modelOptionsByAgentAtom).codex).toEqual([cachedModel]);
  });

  it('still surfaces a global error for an explicit/manual refresh failure', async () => {
    const store: AppStore = createTestStore();
    const listModelOptions = jest.fn().mockRejectedValue(new Error('offline'));
    const context = createContext(listModelOptions);
    const resultRef: { current: ReturnType<typeof useMainScreenModeConfigurationSession> | null } =
      { current: null };

    await act(async () => {
      renderer.create(withAppStore(store, <Harness context={context} resultRef={resultRef} />));
    });

    await act(async () => {
      await resultRef.current?.refreshModelOptions();
    });
    await flush();

    expect(store.get(errorAtom)).toBe('offline');
  });
});
