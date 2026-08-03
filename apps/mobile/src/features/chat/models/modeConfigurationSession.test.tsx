import renderer, { act } from 'react-test-renderer';
import { useMainScreenModeConfigurationSession } from './modeConfigurationSession';
import type { MainScreenModeConfigurationSessionContext } from './modeConfigurationSession';
import { errorAtom } from '../state/turn';
import {
  modelOptionsByAgentAtom,
  loadingModelsAtom,
  pendingAcpConfigByChatAtom,
  selectedEffortAtom,
} from '../state/models';
import { effortModalVisibleAtom } from '../state/modals';
import { createTestStore, withAppStore } from '@shell/state/testing';
import type { AppStore } from '@shell/state/types';
import type { Chat, ModelOption } from '@bridge/types/types';

const cachedModel: ModelOption = {
  id: 'gpt-cached',
  displayName: 'Cached model',
  providerId: 'openai',
  isDefault: false,
  reasoningEffort: [],
  defaultReasoningEffort: undefined,
};

const configuredChat = {
  id: 'thread-1',
  agentId: 'codex',
  acpConfig: [
    {
      id: 'model',
      category: 'model',
      value: 'gpt-a',
      options: [
        { value: 'gpt-a', name: 'GPT A' },
        { value: 'gpt-b', name: 'GPT B' },
      ],
    },
    {
      id: 'effort',
      category: 'thought_level',
      value: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
  ],
} as Chat;

function configuredChatWith(configId: 'model' | 'effort', value: string): Chat {
  return {
    ...configuredChat,
    acpConfig: configuredChat.acpConfig?.map((option) =>
      option.id === configId ? { ...option, value } : option,
    ),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type TestContextOverrides = Omit<Partial<MainScreenModeConfigurationSessionContext>, 'api'> & {
  api?: Pick<
    MainScreenModeConfigurationSessionContext['api'],
    'listModelOptions' | 'peekModelOptions' | 'setThreadConfigOption'
  >;
};

function createContext(
  listModelOptions: jest.Mock,
  overrides: TestContextOverrides = {},
): MainScreenModeConfigurationSessionContext {
  return {
    activeAgentId: 'codex',
    activeModelId: null,
    effectiveModelId: null,
    activeServiceTier: null,
    api: {
      listModelOptions,
      peekModelOptions: jest.fn().mockReturnValue(null),
      setThreadConfigOption: jest.fn(),
    },
    chatModelPreferencesRef: { current: {} },
    effortConfig: null,
    modelOptionsRequestRef: { current: 0 },
    rememberChatModelPreference: jest.fn(),
    saveChatModelPreferences: jest.fn(),
    selectedChatId: null,
    selectedChatRef: { current: null },
    setSelectedChat: jest.fn(),
    ...overrides,
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
    expect(store.get(modelOptionsByAgentAtom)['codex']).toEqual([cachedModel]);
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

describe('useMainScreenModeConfigurationSession config outbox', () => {
  it('accepts an effort selection and dismisses its sheet before persistence resolves', async () => {
    const store: AppStore = createTestStore();
    store.set(effortModalVisibleAtom, true);
    const request = deferred<Chat>();
    const setThreadConfigOption = jest.fn().mockReturnValue(request.promise);
    const context = createContext(jest.fn(), {
      activeModelId: 'gpt-a',
      effectiveModelId: 'gpt-a',
      effortConfig: configuredChat.acpConfig?.[1] ?? null,
      selectedChatId: configuredChat.id,
      selectedChatRef: { current: configuredChat },
      api: {
        listModelOptions: jest.fn(),
        peekModelOptions: jest.fn().mockReturnValue(null),
        setThreadConfigOption,
      },
    });
    const resultRef: { current: ReturnType<typeof useMainScreenModeConfigurationSession> | null } =
      { current: null };

    act(() => {
      renderer.create(withAppStore(store, <Harness context={context} resultRef={resultRef} />));
    });
    act(() => {
      resultRef.current?.selectEffort('high');
    });

    expect(store.get(effortModalVisibleAtom)).toBe(false);
    expect(store.get(selectedEffortAtom)).toBe('high');
    expect(store.get(pendingAcpConfigByChatAtom)[configuredChat.id]?.['thought_level']).toEqual({
      value: 'high',
      revision: 1,
    });
    expect(context.rememberChatModelPreference).not.toHaveBeenCalled();

    await flush();
    expect(setThreadConfigOption).toHaveBeenCalledWith(configuredChat.id, 'effort', 'high');
    expect(
      store.get(pendingAcpConfigByChatAtom)[configuredChat.id]?.['thought_level'],
    ).toBeDefined();

    request.resolve(configuredChatWith('effort', 'high'));
    await flush();
    expect(store.get(pendingAcpConfigByChatAtom)[configuredChat.id]).toBeUndefined();
    expect(context.rememberChatModelPreference).toHaveBeenCalledWith(
      configuredChat.id,
      'gpt-a',
      'high',
      null,
    );
  });

  it('serializes writes and keeps the newest optimistic value over an older response', async () => {
    const store: AppStore = createTestStore();
    const first = deferred<Chat>();
    const second = deferred<Chat>();
    const setThreadConfigOption = jest
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const selectedChatRef = { current: configuredChat as Chat | null };
    const setSelectedChat = jest.fn();
    const context = createContext(jest.fn(), {
      selectedChatId: configuredChat.id,
      selectedChatRef,
      setSelectedChat,
      api: {
        listModelOptions: jest.fn(),
        peekModelOptions: jest.fn().mockReturnValue(null),
        setThreadConfigOption,
      },
    });
    const resultRef: { current: ReturnType<typeof useMainScreenModeConfigurationSession> | null } =
      { current: null };

    act(() => {
      renderer.create(withAppStore(store, <Harness context={context} resultRef={resultRef} />));
    });
    act(() => {
      expect(
        resultRef.current?.applyAcpConfigOption(configuredChat.acpConfig?.[0] ?? null, 'gpt-a'),
      ).toBe(true);
      expect(
        resultRef.current?.applyAcpConfigOption(configuredChat.acpConfig?.[0] ?? null, 'gpt-b'),
      ).toBe(true);
    });
    expect(store.get(pendingAcpConfigByChatAtom)[configuredChat.id]?.['model']).toEqual({
      value: 'gpt-b',
      revision: 2,
    });

    await flush();
    expect(setThreadConfigOption).toHaveBeenCalledTimes(1);
    first.resolve(configuredChatWith('model', 'gpt-a'));
    await flush();

    expect(setThreadConfigOption).toHaveBeenCalledTimes(2);
    expect(store.get(pendingAcpConfigByChatAtom)[configuredChat.id]?.['model']?.value).toBe(
      'gpt-b',
    );

    second.resolve(configuredChatWith('model', 'gpt-b'));
    await flush();
    expect(store.get(pendingAcpConfigByChatAtom)[configuredChat.id]).toBeUndefined();
    expect(setSelectedChat).toHaveBeenLastCalledWith(configuredChatWith('model', 'gpt-b'));
  });

  it('reverts only the latest failed optimistic value and surfaces the error', async () => {
    const store: AppStore = createTestStore();
    const request = deferred<Chat>();
    const context = createContext(jest.fn(), {
      selectedChatId: configuredChat.id,
      selectedChatRef: { current: configuredChat },
      api: {
        listModelOptions: jest.fn(),
        peekModelOptions: jest.fn().mockReturnValue(null),
        setThreadConfigOption: jest.fn().mockReturnValue(request.promise),
      },
    });
    const resultRef: { current: ReturnType<typeof useMainScreenModeConfigurationSession> | null } =
      { current: null };

    act(() => {
      renderer.create(withAppStore(store, <Harness context={context} resultRef={resultRef} />));
    });
    act(() => {
      expect(
        resultRef.current?.applyAcpConfigOption(configuredChat.acpConfig?.[0] ?? null, 'gpt-b'),
      ).toBe(true);
    });
    await flush();
    await act(async () => {
      request.reject(new Error('Agent rejected model'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(store.get(pendingAcpConfigByChatAtom)[configuredChat.id]).toBeUndefined();
    expect(store.get(errorAtom)).toBe('Agent rejected model');
  });
});
