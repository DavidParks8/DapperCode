import type {
  CollaborationMode,
  ModelOption,
  ReasoningEffort,
  ServiceTier,
} from '@bridge/types/types';
import { formatModelOptionLabel } from './options';
import type { MainScreenModelCatalogStateContext } from './catalogState';
import type { PendingAcpConfigByChat } from '../state/models';
import {
  normalizeModelId,
  normalizeReasoningEffort,
  normalizeServiceTier,
  resolveSelectedServiceTier,
  toSelectedServiceTier,
  formatCollaborationModeLabel,
  formatReasoningEffort,
} from '../helpers/helpers';

export type DerivedModelCatalogState = {
  serverDefaultModel: ModelOption | null;
  serverDefaultModelId: string | null;
  selectedModel: ModelOption | null;
  preferredDefaultModel: ModelOption | null;
  activeModel: ModelOption | null;
  unresolvedDefaultModelId: string | null;
  activeModelId: string | null;
  effectiveModelId: string | null;
  effortPickerModel: ModelOption | null;
  effortPickerOptions: NonNullable<ModelOption['reasoningEffort']>;
  effortPickerDefault: ModelOption['defaultReasoningEffort'] | null;
  activeModelEffortOptions: NonNullable<ModelOption['reasoningEffort']>;
  activeModelDefaultEffort: ModelOption['defaultReasoningEffort'] | null;
  requestedEffort: ReasoningEffort | null;
  appliedServiceTierForSelectedChat: ServiceTier | null;
  activeServiceTier: ServiceTier | null;
  fastModeEnabled: boolean;
  supportsSelectedEffort: boolean;
  activeEffort: ReasoningEffort | null;
  effectiveEffort: ReasoningEffort | null;
  activeModelLabel: string;
  activeEffortLabel: string;
  collaborationModeLabel: string;
  hasPendingServiceTierChange: boolean;
  fastModeLabel: string;
  localSelectedModelId: string | null;
  localSelectedEffort: ReasoningEffort | null;
};
function findModelOption(modelOptions: ModelOption[], modelId: string | null): ModelOption | null {
  if (!modelId) {
    return null;
  }
  return modelOptions.find((model) => model.id === modelId) ?? null;
}
function getServerDefaultModel(modelOptions: ModelOption[]): ModelOption | null {
  return modelOptions.find((model) => model.isDefault) ?? null;
}
function resolveRequestedModelId(params: {
  selectedChatId: string | null;
  authoritativeModelId: string | null;
  localSelectedModelId: string | null;
  preferredDefaultModelId: string | null;
}): string | null {
  const { selectedChatId, authoritativeModelId, localSelectedModelId, preferredDefaultModelId } =
    params;
  if (selectedChatId) {
    return authoritativeModelId ?? localSelectedModelId;
  }
  return localSelectedModelId ?? preferredDefaultModelId;
}
function resolvePreferredDefaultModel(params: {
  selectedChatId: string | null;
  preferredDefaultModelId: string | null;
  modelOptions: ModelOption[];
}): ModelOption | null {
  const { selectedChatId, preferredDefaultModelId, modelOptions } = params;
  if (selectedChatId) {
    return null;
  }
  return findModelOption(modelOptions, preferredDefaultModelId);
}
function resolveActiveModel(params: {
  selectedModel: ModelOption | null;
  requestedModelId: string | null;
  preferredDefaultModel: ModelOption | null;
  serverDefaultModel: ModelOption | null;
}): ModelOption | null {
  const { selectedModel, requestedModelId, preferredDefaultModel, serverDefaultModel } = params;
  if (selectedModel) {
    return selectedModel;
  }
  if (requestedModelId) {
    return null;
  }
  return preferredDefaultModel ?? serverDefaultModel ?? null;
}
function resolveRequestedEffort(params: {
  authoritativeEffort: ReasoningEffort | null;
  localSelectedEffort: ReasoningEffort | null;
  selectedChatId: string | null;
  preferredDefaultEffort: ReasoningEffort | null;
}) {
  const { authoritativeEffort, localSelectedEffort, selectedChatId, preferredDefaultEffort } =
    params;
  if (authoritativeEffort) {
    return authoritativeEffort;
  }
  if (localSelectedEffort) {
    return localSelectedEffort;
  }
  return selectedChatId ? null : preferredDefaultEffort;
}
function resolveAppliedServiceTierForSelectedChat(params: {
  selectedChatId: string | null;
  chatModelPreferencesRef: MainScreenModelCatalogStateContext['chatModelPreferencesRef'];
  defaultServiceTier: ServiceTier | null;
}) {
  const { selectedChatId, chatModelPreferencesRef, defaultServiceTier } = params;
  const serviceTierValue = selectedChatId
    ? normalizeServiceTier(chatModelPreferencesRef.current[selectedChatId]?.serviceTier ?? null)
    : defaultServiceTier;
  return toSelectedServiceTier(serviceTierValue);
}
function resolveSupportsSelectedEffort(params: {
  requestedEffort: ReasoningEffort | null;
  authoritativeEffort: ReasoningEffort | null;
  activeModelEffortOptions: NonNullable<ModelOption['reasoningEffort']>;
}): boolean {
  const { requestedEffort, authoritativeEffort, activeModelEffortOptions } = params;
  if (!requestedEffort) {
    return false;
  }
  if (authoritativeEffort) {
    return true;
  }
  return activeModelEffortOptions.some((option) => option.effort === requestedEffort);
}
function resolveCollaborationModeLabel(params: {
  modeConfig: MainScreenModelCatalogStateContext['modeConfig'];
  pendingModeValue?: string;
  selectedAcpModeId: string | null;
  selectedCollaborationMode: CollaborationMode;
}): string {
  const { modeConfig, pendingModeValue, selectedAcpModeId, selectedCollaborationMode } = params;
  const pendingLabel = pendingModeValue
    ? (modeConfig?.options?.find((option) => option.value === pendingModeValue)?.name ??
      pendingModeValue)
    : null;
  if (pendingLabel) {
    return pendingLabel;
  }
  const configuredLabel =
    modeConfig?.options?.find((option) => option.value === modeConfig.value)?.name ??
    modeConfig?.value;
  if (configuredLabel) {
    return configuredLabel;
  }
  if (selectedAcpModeId && !['build', 'plan'].includes(selectedAcpModeId)) {
    return selectedAcpModeId;
  }
  return formatCollaborationModeLabel(selectedCollaborationMode);
}
function resolveFastModeLabel(
  hasPendingServiceTierChange: boolean,
  fastModeEnabled: boolean,
): string {
  if (!hasPendingServiceTierChange) {
    return fastModeEnabled ? 'Fast mode on' : 'Fast mode off';
  }
  return `${fastModeEnabled ? 'Fast mode on' : 'Fast mode off'} · next message`;
}
export function shouldResetSelectedEffort(
  activeModel: ModelOption | null,
  localSelectedEffort: ReasoningEffort | null,
  localSelectedModelId: string | null,
): boolean {
  if (!localSelectedEffort || !localSelectedModelId || !activeModel) {
    return false;
  }
  const effortOptions = activeModel.reasoningEffort ?? [];
  if (effortOptions.length === 0) {
    return false;
  }
  return !effortOptions.some((option) => option.effort === localSelectedEffort);
}
function resolveRequestedSelections(params: {
  selectedChatId: string | null;
  selectionBelongsToCurrentChat: boolean;
  modelConfig: MainScreenModelCatalogStateContext['modelConfig'];
  effortConfig: MainScreenModelCatalogStateContext['effortConfig'];
  selectedModelId: string | null;
  selectedEffort: ReasoningEffort | null;
  preferredDefaultModelId: string | null;
  preferredDefaultEffort: ReasoningEffort | null;
  pendingAcpConfig?: PendingAcpConfigByChat[string];
}) {
  const authoritativeModelId = params.selectedChatId
    ? normalizeModelId(params.pendingAcpConfig?.['model']?.value ?? params.modelConfig?.value)
    : null;
  const authoritativeEffort = params.selectedChatId
    ? normalizeReasoningEffort(
        params.pendingAcpConfig?.['thought_level']?.value ?? params.effortConfig?.value,
      )
    : null;
  const localSelectedModelId = params.selectionBelongsToCurrentChat ? params.selectedModelId : null;
  const localSelectedEffort = params.selectionBelongsToCurrentChat ? params.selectedEffort : null;
  return {
    authoritativeModelId,
    authoritativeEffort,
    localSelectedModelId,
    localSelectedEffort,
    requestedModelId: resolveRequestedModelId({
      selectedChatId: params.selectedChatId,
      authoritativeModelId,
      localSelectedModelId,
      preferredDefaultModelId: params.preferredDefaultModelId,
    }),
    requestedEffort: resolveRequestedEffort({
      authoritativeEffort,
      localSelectedEffort,
      selectedChatId: params.selectedChatId,
      preferredDefaultEffort: params.preferredDefaultEffort,
    }),
  };
}
function resolveModelState(params: {
  selectedChatId: string | null;
  preferredDefaultModelId: string | null;
  modelOptions: ModelOption[];
  requestedModelId: string | null;
}) {
  const serverDefaultModel = getServerDefaultModel(params.modelOptions);
  const serverDefaultModelId = serverDefaultModel?.id ?? null;
  const selectedModel = findModelOption(params.modelOptions, params.requestedModelId);
  const preferredDefaultModel = resolvePreferredDefaultModel({
    selectedChatId: params.selectedChatId,
    preferredDefaultModelId: params.preferredDefaultModelId,
    modelOptions: params.modelOptions,
  });
  const activeModel = resolveActiveModel({
    selectedModel,
    requestedModelId: params.requestedModelId,
    preferredDefaultModel,
    serverDefaultModel,
  });
  return {
    serverDefaultModel,
    serverDefaultModelId,
    selectedModel,
    preferredDefaultModel,
    activeModel,
    unresolvedDefaultModelId:
      params.requestedModelId && !activeModel ? params.requestedModelId : null,
    activeModelId: params.requestedModelId,
    effectiveModelId: params.requestedModelId ?? serverDefaultModelId,
  };
}
function resolveEffortState(params: {
  modelOptions: ModelOption[];
  effortPickerModelId: string | null;
  activeModel: ModelOption | null;
  requestedEffort: ReasoningEffort | null;
  authoritativeEffort: ReasoningEffort | null;
}) {
  const effortPickerModel = params.effortPickerModelId
    ? findModelOption(params.modelOptions, params.effortPickerModelId)
    : params.activeModel;
  const effortPickerOptions = effortPickerModel?.reasoningEffort ?? [];
  const effortPickerDefault = effortPickerModel?.defaultReasoningEffort ?? null;
  const activeModelEffortOptions = params.activeModel?.reasoningEffort ?? [];
  const activeModelDefaultEffort = params.activeModel?.defaultReasoningEffort ?? null;
  const supportsSelectedEffort = resolveSupportsSelectedEffort({
    requestedEffort: params.requestedEffort,
    authoritativeEffort: params.authoritativeEffort,
    activeModelEffortOptions,
  });
  const activeEffort = supportsSelectedEffort ? params.requestedEffort : null;
  return {
    effortPickerModel,
    effortPickerOptions,
    effortPickerDefault,
    activeModelEffortOptions,
    activeModelDefaultEffort,
    supportsSelectedEffort,
    activeEffort,
    effectiveEffort: activeEffort ?? activeModelDefaultEffort,
  };
}
function resolveServiceTierState(params: {
  selectedChatId: string | null;
  chatModelPreferencesRef: MainScreenModelCatalogStateContext['chatModelPreferencesRef'];
  defaultServiceTier: ServiceTier | null;
  selectedServiceTier: ServiceTier | null | undefined;
  supportsFastMode: boolean;
}) {
  const appliedServiceTierForSelectedChat = resolveAppliedServiceTierForSelectedChat({
    selectedChatId: params.selectedChatId,
    chatModelPreferencesRef: params.chatModelPreferencesRef,
    defaultServiceTier: params.defaultServiceTier,
  });
  const activeServiceTier = params.supportsFastMode
    ? resolveSelectedServiceTier(
        params.selectedServiceTier,
        params.selectedChatId ? null : params.defaultServiceTier,
      )
    : null;
  const fastModeEnabled = activeServiceTier === 'fast';
  const hasPendingServiceTierChange =
    Boolean(params.selectedChatId) && appliedServiceTierForSelectedChat !== activeServiceTier;
  return {
    appliedServiceTierForSelectedChat,
    activeServiceTier,
    fastModeEnabled,
    hasPendingServiceTierChange,
    fastModeLabel: resolveFastModeLabel(hasPendingServiceTierChange, fastModeEnabled),
  };
}
function resolveDisplayLabels(params: {
  activeModel: ModelOption | null;
  effectiveModelId: string | null;
  effectiveEffort: ReasoningEffort | null;
  modeConfig: MainScreenModelCatalogStateContext['modeConfig'];
  selectedAcpModeId: string | null;
  selectedCollaborationMode: CollaborationMode;
  pendingModeValue?: string;
}) {
  return {
    activeModelLabel: params.activeModel
      ? formatModelOptionLabel(params.activeModel)
      : params.effectiveModelId
        ? params.effectiveModelId
        : 'Server default model',
    activeEffortLabel: params.effectiveEffort
      ? formatReasoningEffort(params.effectiveEffort)
      : 'Model default',
    collaborationModeLabel: resolveCollaborationModeLabel({
      modeConfig: params.modeConfig,
      pendingModeValue: params.pendingModeValue,
      selectedAcpModeId: params.selectedAcpModeId,
      selectedCollaborationMode: params.selectedCollaborationMode,
    }),
  };
}
export function deriveModelCatalogState(params: {
  selectedChatId: string | null;
  selectionBelongsToCurrentChat: boolean;
  modelConfig: MainScreenModelCatalogStateContext['modelConfig'];
  effortConfig: MainScreenModelCatalogStateContext['effortConfig'];
  modeConfig: MainScreenModelCatalogStateContext['modeConfig'];
  modelOptions: ModelOption[];
  preferredDefaultModelId: string | null;
  preferredDefaultEffort: ReasoningEffort | null;
  chatModelPreferencesRef: MainScreenModelCatalogStateContext['chatModelPreferencesRef'];
  defaultServiceTier: ServiceTier | null;
  selectedServiceTier: ServiceTier | null | undefined;
  supportsFastMode: boolean;
  selectedAcpModeId: string | null;
  selectedCollaborationMode: CollaborationMode;
  effortPickerModelId: string | null;
  selectedModelId: string | null;
  selectedEffort: ReasoningEffort | null;
  pendingAcpConfig?: PendingAcpConfigByChat[string];
}): DerivedModelCatalogState {
  const requestedSelections = resolveRequestedSelections({
    selectedChatId: params.selectedChatId,
    selectionBelongsToCurrentChat: params.selectionBelongsToCurrentChat,
    modelConfig: params.modelConfig,
    effortConfig: params.effortConfig,
    selectedModelId: params.selectedModelId,
    selectedEffort: params.selectedEffort,
    preferredDefaultModelId: params.preferredDefaultModelId,
    preferredDefaultEffort: params.preferredDefaultEffort,
    pendingAcpConfig: params.pendingAcpConfig,
  });
  const modelState = resolveModelState({
    selectedChatId: params.selectedChatId,
    preferredDefaultModelId: params.preferredDefaultModelId,
    modelOptions: params.modelOptions,
    requestedModelId: requestedSelections.requestedModelId,
  });
  const effortState = resolveEffortState({
    modelOptions: params.modelOptions,
    effortPickerModelId: params.effortPickerModelId,
    activeModel: modelState.activeModel,
    requestedEffort: requestedSelections.requestedEffort,
    authoritativeEffort: requestedSelections.authoritativeEffort,
  });
  const serviceTierState = resolveServiceTierState({
    selectedChatId: params.selectedChatId,
    chatModelPreferencesRef: params.chatModelPreferencesRef,
    defaultServiceTier: params.defaultServiceTier,
    selectedServiceTier: params.selectedServiceTier,
    supportsFastMode: params.supportsFastMode,
  });
  const displayLabels = resolveDisplayLabels({
    activeModel: modelState.activeModel,
    effectiveModelId: modelState.effectiveModelId,
    effectiveEffort: effortState.effectiveEffort,
    modeConfig: params.modeConfig,
    selectedAcpModeId: params.selectedAcpModeId,
    selectedCollaborationMode: params.selectedCollaborationMode,
    pendingModeValue: params.pendingAcpConfig?.['mode']?.value,
  });
  return {
    ...modelState,
    ...effortState,
    ...serviceTierState,
    ...displayLabels,
    requestedEffort: requestedSelections.requestedEffort,
    localSelectedModelId: requestedSelections.localSelectedModelId,
    localSelectedEffort: requestedSelections.localSelectedEffort,
  };
}
