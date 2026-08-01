import {
  bridgeCapabilitiesAtom,
  defaultServiceTierAtom,
  selectedAcpModeIdAtom,
  selectedCollaborationModeAtom,
  selectedEffortAtom,
  selectedModelIdAtom,
  selectedServiceTierAtom,
} from '../../state/mainScreen/models';
import { activityAtom } from '../../state/mainScreen/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useEffect, useRef } from 'react';
import type { CollaborationMode } from '../../api/types';
import { selectAgentId } from '../../agents';
import { formatModelOptionLabel } from '../../modelOptions';
import {
  normalizeModelId,
  normalizeReasoningEffort,
  normalizeServiceTier,
  toSelectedServiceTier,
  resolveSelectedServiceTier,
  formatCollaborationModeLabel,
  formatReasoningEffort,
} from './mainScreenHelpers';
import type {
  MainScreenSelectedRuntimeSelectorsContext,
  MainScreenSelectedRuntimeSelectorsResult,
} from './mainScreenSelectedRuntimeSelectors';
import { effortPickerModelIdAtom } from '../../state/mainScreen/modals';

export type MainScreenModelCatalogStateContext = MainScreenSelectedRuntimeSelectorsContext &
  MainScreenSelectedRuntimeSelectorsResult;

export function useMainScreenModelCatalogState(context: MainScreenModelCatalogStateContext) {
  const {
    chatModelPreferencesLoaded,
    chatModelPreferencesRef,
    effortConfig,
    modeConfig,
    modelConfig,
    modelOptions,
    pendingAgentId,
    preferredAgentId,
    preferredCollaborationMode,
    preferredDefaultEffort,
    preferredDefaultModelId,
    preferredServiceTier,
    selectedChatId,
    setPendingAgentId,
    supportsFastMode,
  } = context;
  const bridgeCapabilities = useAtomValue(bridgeCapabilitiesAtom);
  const selectedModelId = useAtomValue(selectedModelIdAtom);
  const selectedEffort = useAtomValue(selectedEffortAtom);
  const selectedServiceTier = useAtomValue(selectedServiceTierAtom);
  const defaultServiceTier = useAtomValue(defaultServiceTierAtom);
  const selectedCollaborationMode = useAtomValue(selectedCollaborationModeAtom);
  const selectedAcpModeId = useAtomValue(selectedAcpModeIdAtom);
  const setSelectedModelId = useSetAtom(selectedModelIdAtom);
  const setSelectedEffort = useSetAtom(selectedEffortAtom);
  const setSelectedServiceTier = useSetAtom(selectedServiceTierAtom);
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const activity = useAtomValue(activityAtom);
  const setActivity = useSetAtom(activityAtom);
  const effortPickerModelId = useAtomValue(effortPickerModelIdAtom);
  const selectionChatIdRef = useRef(selectedChatId);
  const selectionBelongsToCurrentChat = selectionChatIdRef.current === selectedChatId;

  useEffect(() => {
    if (selectedChatId) {
      return;
    }

    if (bridgeCapabilities) {
      setPendingAgentId(selectAgentId(pendingAgentId ?? preferredAgentId, bridgeCapabilities));
    }
  }, [bridgeCapabilities, pendingAgentId, preferredAgentId, selectedChatId]);

  useEffect(() => {
    if (!chatModelPreferencesLoaded) {
      return;
    }

    const chatId = selectedChatId?.trim();
    if (!chatId) {
      return;
    }

    const preference = chatModelPreferencesRef.current[chatId];
    setSelectedServiceTier(toSelectedServiceTier(preference?.serviceTier ?? null));
  }, [chatModelPreferencesLoaded, selectedChatId]);

  useEffect(() => {
    if (selectionChatIdRef.current === selectedChatId) {
      return;
    }
    selectionChatIdRef.current = selectedChatId;
    setSelectedModelId(null);
    setSelectedEffort(null);
  }, [selectedChatId]);

  useEffect(() => {
    if (selectedChatId) {
      return;
    }

    setSelectedModelId(preferredDefaultModelId);
    setSelectedEffort(preferredDefaultEffort);
    setSelectedServiceTier(preferredServiceTier);
    setSelectedCollaborationMode(preferredCollaborationMode as CollaborationMode);
  }, [
    defaultServiceTier,
    pendingAgentId,
    preferredDefaultEffort,
    preferredDefaultModelId,
    preferredCollaborationMode,
    preferredServiceTier,
    selectedChatId,
  ]);

  const authoritativeModelId = selectedChatId ? normalizeModelId(modelConfig?.value) : null;
  const authoritativeEffort = selectedChatId ? normalizeReasoningEffort(effortConfig?.value) : null;
  const localSelectedModelId = selectionBelongsToCurrentChat ? selectedModelId : null;
  const localSelectedEffort = selectionBelongsToCurrentChat ? selectedEffort : null;
  const requestedModelId = selectedChatId
    ? (authoritativeModelId ?? localSelectedModelId)
    : (localSelectedModelId ?? preferredDefaultModelId);
  const serverDefaultModel = modelOptions.find((model) => model.isDefault) ?? null;
  const serverDefaultModelId = serverDefaultModel?.id ?? null;
  const selectedModel = requestedModelId
    ? (modelOptions.find((model) => model.id === requestedModelId) ?? null)
    : null;
  const preferredDefaultModel =
    !selectedChatId && preferredDefaultModelId
      ? (modelOptions.find((model) => model.id === preferredDefaultModelId) ?? null)
      : null;
  const activeModel =
    selectedModel ??
    (requestedModelId ? null : (preferredDefaultModel ?? serverDefaultModel)) ??
    null;
  const unresolvedDefaultModelId = requestedModelId && !activeModel ? requestedModelId : null;
  // Defaults are effective display values, not explicit turn overrides.
  const activeModelId = requestedModelId;
  const effectiveModelId = requestedModelId ?? serverDefaultModelId;
  const effortPickerModel = effortPickerModelId
    ? (modelOptions.find((model) => model.id === effortPickerModelId) ?? null)
    : activeModel;
  const effortPickerOptions = effortPickerModel?.reasoningEffort ?? [];
  const effortPickerDefault = effortPickerModel?.defaultReasoningEffort ?? null;
  const activeModelEffortOptions = activeModel?.reasoningEffort ?? [];
  const activeModelDefaultEffort = activeModel?.defaultReasoningEffort ?? null;
  const requestedEffort =
    authoritativeEffort ?? localSelectedEffort ?? (!selectedChatId ? preferredDefaultEffort : null);
  const appliedServiceTierForSelectedChat = toSelectedServiceTier(
    selectedChatId
      ? normalizeServiceTier(chatModelPreferencesRef.current[selectedChatId]?.serviceTier ?? null)
      : defaultServiceTier,
  );
  const activeServiceTier = supportsFastMode
    ? resolveSelectedServiceTier(selectedServiceTier, selectedChatId ? null : defaultServiceTier)
    : null;
  const fastModeEnabled = activeServiceTier === 'fast';
  const supportsSelectedEffort = Boolean(
    requestedEffort &&
    (authoritativeEffort ||
      activeModelEffortOptions.some((option) => option.effort === requestedEffort)),
  );
  const activeEffort = supportsSelectedEffort ? requestedEffort : null;
  const effectiveEffort = activeEffort ?? activeModelDefaultEffort;
  const activeModelLabel = activeModel
    ? formatModelOptionLabel(activeModel)
    : effectiveModelId
      ? effectiveModelId
      : 'Server default model';
  const activeEffortLabel = effectiveEffort
    ? formatReasoningEffort(effectiveEffort)
    : 'Model default';
  const collaborationModeLabel =
    modeConfig?.options?.find((option) => option.value === modeConfig.value)?.name ??
    modeConfig?.value ??
    (selectedAcpModeId && !['build', 'plan'].includes(selectedAcpModeId)
      ? selectedAcpModeId
      : formatCollaborationModeLabel(selectedCollaborationMode));
  const hasPendingServiceTierChange =
    Boolean(selectedChatId) && appliedServiceTierForSelectedChat !== activeServiceTier;
  const fastModeLabel = hasPendingServiceTierChange
    ? `${fastModeEnabled ? 'Fast mode on' : 'Fast mode off'} · next message`
    : fastModeEnabled
      ? 'Fast mode on'
      : 'Fast mode off';

  // Auto-transition complete/error → idle after 3s so the bar hides.
  useEffect(() => {
    if (activity.tone !== 'complete' && activity.tone !== 'error') {
      return;
    }
    const timer = setTimeout(() => {
      setActivity({ tone: 'idle', title: 'Ready' });
    }, 3000);
    return () => clearTimeout(timer);
  }, [activity.tone]);

  useEffect(() => {
    if (!localSelectedEffort) {
      return;
    }

    if (!localSelectedModelId) {
      return;
    }

    if (!activeModel) {
      return;
    }

    const effortOptions = activeModel.reasoningEffort ?? [];
    if (effortOptions.length === 0) {
      return;
    }

    const supportsSelectedEffort = effortOptions.some(
      (option) => option.effort === localSelectedEffort,
    );
    if (!supportsSelectedEffort) {
      setSelectedEffort(null);
    }
  }, [activeModel, localSelectedEffort, localSelectedModelId]);

  return {
    serverDefaultModel,
    serverDefaultModelId,
    selectedModel,
    preferredDefaultModel,
    activeModel,
    unresolvedDefaultModelId,
    activeModelId,
    effectiveModelId,
    effortPickerModel,
    effortPickerOptions,
    effortPickerDefault,
    activeModelEffortOptions,
    activeModelDefaultEffort,
    requestedEffort,
    appliedServiceTierForSelectedChat,
    activeServiceTier,
    fastModeEnabled,
    supportsSelectedEffort,
    activeEffort,
    effectiveEffort,
    activeModelLabel,
    activeEffortLabel,
    collaborationModeLabel,
    hasPendingServiceTierChange,
    fastModeLabel,
  };
}

export type MainScreenModelCatalogStateResult = ReturnType<typeof useMainScreenModelCatalogState>;
