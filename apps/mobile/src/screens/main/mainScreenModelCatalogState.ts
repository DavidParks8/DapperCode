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
import { toSelectedServiceTier } from './mainScreenHelpers';
import type {
  MainScreenSelectedRuntimeSelectorsContext,
  MainScreenSelectedRuntimeSelectorsResult,
} from './mainScreenSelectedRuntimeSelectors';
import { effortPickerModelIdAtom } from '../../state/mainScreen/modals';
import {
  deriveModelCatalogState,
  shouldResetSelectedEffort,
} from './mainScreenModelCatalogDerivation';
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
  }, [bridgeCapabilities, pendingAgentId, preferredAgentId, selectedChatId, setPendingAgentId]);
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
  }, [chatModelPreferencesLoaded, chatModelPreferencesRef, selectedChatId, setSelectedServiceTier]);
  useEffect(() => {
    if (selectionChatIdRef.current === selectedChatId) {
      return;
    }
    selectionChatIdRef.current = selectedChatId;
    setSelectedModelId(null);
    setSelectedEffort(null);
  }, [selectedChatId, setSelectedEffort, setSelectedModelId]);
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
    setSelectedCollaborationMode,
    setSelectedEffort,
    setSelectedModelId,
    setSelectedServiceTier,
  ]);
  const {
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
    localSelectedModelId,
    localSelectedEffort,
  } = deriveModelCatalogState({
    selectedChatId,
    selectionBelongsToCurrentChat,
    modelConfig,
    effortConfig,
    modeConfig,
    modelOptions,
    preferredDefaultModelId,
    preferredDefaultEffort,
    chatModelPreferencesRef,
    defaultServiceTier,
    selectedServiceTier,
    supportsFastMode,
    selectedAcpModeId,
    selectedCollaborationMode,
    effortPickerModelId,
    selectedModelId,
    selectedEffort,
  });
  // Auto-transition complete/error → idle after 3s so the bar hides.
  useEffect(() => {
    if (activity.tone !== 'complete' && activity.tone !== 'error') {
      return;
    }
    const timer = setTimeout(() => {
      setActivity({ tone: 'idle', title: 'Ready' });
    }, 3000);
    return () => clearTimeout(timer);
  }, [activity.tone, setActivity]);
  useEffect(() => {
    if (shouldResetSelectedEffort(activeModel, localSelectedEffort, localSelectedModelId)) {
      setSelectedEffort(null);
    }
  }, [activeModel, localSelectedEffort, localSelectedModelId, setSelectedEffort]);
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
