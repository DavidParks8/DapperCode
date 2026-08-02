import { errorAtom } from '../state/turn';
import { loadingModelsAtom, modelOptionsByAgentAtom, selectedEffortAtom } from '../state/models';
import { useSetAtom } from 'jotai';
import { useCallback } from 'react';
import type { AcpConfigOption, Chat, ReasoningEffort } from '@bridge/types/types';
import { normalizeModelId } from '../helpers/helpers';
import { agentModelPreferenceKey } from '../helpers/preferences';
import type {
  MainScreenWorkspaceCheckoutActionsContext,
  MainScreenWorkspaceCheckoutActionsResult,
} from '../session/workspaceCheckoutActions';
import { EMPTY_MODEL_OPTIONS } from '../screen/constants';
import {
  agentModalVisibleAtom,
  effortModalVisibleAtom,
  effortPickerModelIdAtom,
  modelModalVisibleAtom,
} from '../state/modals';

export type MainScreenModeConfigurationSessionContext = MainScreenWorkspaceCheckoutActionsContext &
  MainScreenWorkspaceCheckoutActionsResult;

export function useMainScreenModeConfigurationSession(
  context: MainScreenModeConfigurationSessionContext,
) {
  const {
    activeAgentId,
    activeModelId,
    effectiveModelId,
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
        // Silent/background refreshes keep serving whatever models are already
        // cached and must not surface a global error; only explicit/manual
        // refreshes (e.g. opening the model picker with nothing cached) should.
        if (modelOptionsRequestRef.current === requestId && !options?.silent) {
          setError((err as Error).message);
        }
      } finally {
        if (!options?.silent && modelOptionsRequestRef.current === requestId) {
          setLoadingModels(false);
        }
      }
    },
    [
      activeAgentId,
      api,
      modelOptionsRequestRef,
      setError,
      setLoadingModels,
      setModelOptionsByAgent,
    ],
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
  }, [activeAgentId, api, refreshModelOptions, setModelModalVisible, setModelOptionsByAgent]);

  const closeModelModal = useCallback(() => {
    setModelModalVisible(false);
  }, [setModelModalVisible]);

  const openAgentModal = useCallback(() => {
    if (selectedChatId) {
      return;
    }
    setAgentModalVisible(true);
    setError(null);
  }, [selectedChatId, setAgentModalVisible, setError]);

  const closeAgentModal = useCallback(() => {
    setAgentModalVisible(false);
  }, [setAgentModalVisible]);

  const openEffortModal = useCallback(
    (modelId?: string | null) => {
      const resolvedModelId = normalizeModelId(modelId ?? effectiveModelId);
      if (!resolvedModelId) {
        setError('Select a model first');
        return;
      }

      setEffortPickerModelId(resolvedModelId);
      setEffortModalVisible(true);
      setError(null);
    },
    [effectiveModelId, setEffortModalVisible, setEffortPickerModelId, setError],
  );

  const closeEffortModal = useCallback(() => {
    setEffortModalVisible(false);
  }, [setEffortModalVisible]);

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
    [api, selectedChatId, selectedChatRef, setError, setSelectedChat],
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
        rememberChatModelPreference(selectedChatId, effectiveModelId, effort, activeServiceTier);
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
      effectiveModelId,
      activeServiceTier,
      activeAgentId,
      applyAcpConfigOption,
      chatModelPreferencesRef,
      effortConfig,
      rememberChatModelPreference,
      saveChatModelPreferences,
      selectedChatId,
      setEffortModalVisible,
      setError,
      setSelectedEffort,
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
