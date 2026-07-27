import { errorAtom } from '../../state/mainScreen/turn';
import {
  loadingModelsAtom,
  modelOptionsByAgentAtom,
  selectedEffortAtom,
} from '../../state/mainScreen/models';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type { AcpConfigOption, Chat, ReasoningEffort } from '../../api/types';
import { normalizeModelId } from './mainScreenHelpers';
import { agentModelPreferenceKey } from './mainScreenHelperPreferences';
import type {
  MainScreenWorkspaceCheckoutActionsContext,
  MainScreenWorkspaceCheckoutActionsResult,
} from './mainScreenWorkspaceCheckoutActions';
import { EMPTY_MODEL_OPTIONS } from './mainScreenConstants';
import {
  agentModalVisibleAtom,
  effortModalVisibleAtom,
  effortPickerModelIdAtom,
  modelModalVisibleAtom,
} from '../../state/mainScreen/modals';

export type MainScreenModeConfigurationSessionContext = MainScreenWorkspaceCheckoutActionsContext &
  MainScreenWorkspaceCheckoutActionsResult;

export function useMainScreenModeConfigurationSession(
  context: MainScreenModeConfigurationSessionContext,
) {
  const {
    activeAgentId,
    activeModelId,
    activeServiceTier,
    api,
    chatModelPreferencesRef,
    effortConfig,
    modelOptionsRequestRef,
    rememberChatModelPreference,
    saveChatModelPreferences,
    selectedChatId,
    selectedChatRef,
    setSelectedChat,
  } = context;
  const setError = useSetAtom(errorAtom);
  const loadingModels = useAtomValue(loadingModelsAtom);
  const setModelOptionsByAgent = useSetAtom(modelOptionsByAgentAtom);
  const setLoadingModels = useSetAtom(loadingModelsAtom);
  const setSelectedEffort = useSetAtom(selectedEffortAtom);
  const setModelModalVisible = useSetAtom(modelModalVisibleAtom);
  const setAgentModalVisible = useSetAtom(agentModalVisibleAtom);
  const setEffortModalVisible = useSetAtom(effortModalVisibleAtom);
  const setEffortPickerModelId = useSetAtom(effortPickerModelIdAtom);

  const refreshModelOptions = useCallback(
    async (options?: { silent?: boolean }) => {
      const requestId = modelOptionsRequestRef.current + 1;
      modelOptionsRequestRef.current = requestId;
      if (!options?.silent) {
        setLoadingModels(true);
      }
      try {
        const catalogModels = await api.listModelOptions(activeAgentId);
        if (modelOptionsRequestRef.current !== requestId) {
          return;
        }
        if (activeAgentId) {
          setModelOptionsByAgent((previous) => ({
            ...previous,
            [activeAgentId]: Array.isArray(catalogModels) ? catalogModels : EMPTY_MODEL_OPTIONS,
          }));
        }
      } catch (err) {
        if (modelOptionsRequestRef.current === requestId) {
          setError((err as Error).message);
        }
      } finally {
        if (!options?.silent && modelOptionsRequestRef.current === requestId) {
          setLoadingModels(false);
        }
      }
    },
    [activeAgentId, api],
  );

  const openModelModal = useCallback(() => {
    // Serve whatever the client already has so the picker opens populated, then revalidate.
    const cachedModels = api.peekModelOptions(activeAgentId);
    const hasCachedModels = Boolean(activeAgentId && cachedModels && cachedModels.length > 0);
    if (activeAgentId && cachedModels && hasCachedModels) {
      setModelOptionsByAgent((previous) => ({ ...previous, [activeAgentId]: cachedModels }));
    }
    setModelModalVisible(true);
    void refreshModelOptions({ silent: hasCachedModels });
  }, [activeAgentId, api, refreshModelOptions]);

  const closeModelModal = useCallback(() => {
    if (loadingModels) {
      return;
    }
    setModelModalVisible(false);
  }, [loadingModels]);

  const openAgentModal = useCallback(() => {
    if (selectedChatId) {
      return;
    }
    setAgentModalVisible(true);
    setError(null);
  }, [selectedChatId]);

  const closeAgentModal = useCallback(() => {
    setAgentModalVisible(false);
  }, []);

  const openEffortModal = useCallback(
    (modelId?: string | null) => {
      const resolvedModelId = normalizeModelId(modelId ?? activeModelId);
      if (!resolvedModelId) {
        setError('Select a model first');
        return;
      }

      setEffortPickerModelId(resolvedModelId);
      setEffortModalVisible(true);
      setError(null);
    },
    [activeModelId],
  );

  const closeEffortModal = useCallback(() => {
    setEffortModalVisible(false);
  }, []);

  const applyAcpConfigOption = useCallback(
    async (config: AcpConfigOption | null, value: string): Promise<Chat | null> => {
      if (!selectedChatId || !config) {
        return null;
      }
      try {
        const updated = await api.setThreadConfigOption(selectedChatId, config.id, value);
        selectedChatRef.current = updated;
        setSelectedChat(updated);
        return updated;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [api, selectedChatId],
  );

  const selectEffort = useCallback(
    async (effort: ReasoningEffort | null) => {
      const value = effort ?? effortConfig?.value;
      if (effortConfig && value) {
        const updated = await applyAcpConfigOption(effortConfig, value);
        if (!updated) {
          return;
        }
      }
      setSelectedEffort(effort);
      setEffortModalVisible(false);
      setError(null);
      if (selectedChatId) {
        rememberChatModelPreference(selectedChatId, activeModelId, effort, activeServiceTier);
      } else if (activeAgentId) {
        const key = agentModelPreferenceKey(activeAgentId);
        const previous = chatModelPreferencesRef.current[key];
        const nextPreferences = {
          ...chatModelPreferencesRef.current,
          [key]: {
            modelId: activeModelId,
            effort,
            serviceTier: activeServiceTier,
            updatedAt: new Date().toISOString(),
            ...(previous?.modelId && !activeModelId ? { modelId: previous.modelId } : {}),
          },
        };
        chatModelPreferencesRef.current = nextPreferences;
        void saveChatModelPreferences(nextPreferences);
      }
    },
    [
      activeModelId,
      activeServiceTier,
      activeAgentId,
      applyAcpConfigOption,
      chatModelPreferencesRef,
      effortConfig,
      rememberChatModelPreference,
      saveChatModelPreferences,
      selectedChatId,
    ],
  );

  return {
    refreshModelOptions,
    openModelModal,
    closeModelModal,
    openAgentModal,
    closeAgentModal,
    openEffortModal,
    closeEffortModal,
    applyAcpConfigOption,
    selectEffort,
  };
}

export type MainScreenModeConfigurationSessionResult = ReturnType<
  typeof useMainScreenModeConfigurationSession
>;
