import { errorAtom } from '../state/turn';
import {
  selectedAcpModeIdAtom,
  selectedCollaborationModeAtom,
  selectedEffortAtom,
  selectedModelIdAtom,
  selectedServiceTierAtom,
} from '../state/models';
import { activityAtom } from '../state/composer';
import { useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo } from 'react';
import { useFocusEffect } from 'expo-router';
import type { AgentId, ServiceTier } from '@bridge/types/types';
import type { SelectionSheetOption } from '@shared/ui/SelectionSheet';
import { normalizeModelId } from '../helpers/helpers';
import { agentModelPreferenceKey } from '../helpers/preferences';
import { ATTACHMENT_MAX_LABEL } from './controllers/attachmentController';
import { useHostModelSelection } from './useHostModelSelection';
import { activeProfileFeaturesAtom } from '@shell/state/bridge/atoms';
import type {
  MainScreenModeConfigurationSessionContext,
  MainScreenModeConfigurationSessionResult,
} from '../models/modeConfigurationSession';
import {
  agentModalVisibleAtom,
  collaborationModeMenuVisibleAtom,
  effortModalVisibleAtom,
  effortPickerModelIdAtom,
  modelModalVisibleAtom,
} from '../state/modals';

export type MainScreenComposerControlActionsContext = MainScreenModeConfigurationSessionContext &
  MainScreenModeConfigurationSessionResult;

export function useMainScreenComposerControlActions(
  context: MainScreenComposerControlActionsContext,
) {
  const { modelLibrary } = useAtomValue(activeProfileFeaturesAtom);
  const {
    activeServiceTier,
    activeAgentId,
    chatModelPreferencesRef,
    agentSettings,
    applyAcpConfigOption,
    attachmentController,
    attachmentPickerBusy,
    hasFailedAttachmentUploads,
    modelConfig,
    modelOptions,
    refreshModelOptions,
    rememberChatModelPreference,
    saveChatModelPreferences,
    retryFailedUploads,
    selectedChatId,
    setPendingAgentId,
    supportsFastMode,
    uploadingAttachment,
    ws,
  } = context;
  const setError = useSetAtom(errorAtom);
  const setSelectedModelId = useSetAtom(selectedModelIdAtom);
  const setSelectedEffort = useSetAtom(selectedEffortAtom);
  const setSelectedServiceTier = useSetAtom(selectedServiceTierAtom);
  const setSelectedCollaborationMode = useSetAtom(selectedCollaborationModeAtom);
  const setSelectedAcpModeId = useSetAtom(selectedAcpModeIdAtom);
  const setActivity = useSetAtom(activityAtom);
  const modelModalVisible = useAtomValue(modelModalVisibleAtom);
  const setModelModalVisible = useSetAtom(modelModalVisibleAtom);
  const setAgentModalVisible = useSetAtom(agentModalVisibleAtom);
  const setCollaborationModeMenuVisible = useSetAtom(collaborationModeMenuVisibleAtom);
  const setEffortModalVisible = useSetAtom(effortModalVisibleAtom);
  const setEffortPickerModelId = useSetAtom(effortPickerModelIdAtom);

  const selectHostDefaultModel = useHostModelSelection(
    ws,
    JSON.stringify([activeAgentId, selectedChatId, modelLibrary]),
  );
  const selectModel = useCallback(
    (modelId: string | null) => {
      const normalizedModelId = normalizeModelId(modelId);
      if (normalizedModelId && modelConfig && (!modelLibrary || selectedChatId)) {
        if (
          !applyAcpConfigOption(
            modelConfig,
            normalizedModelId,
            selectedChatId
              ? () => {
                  rememberChatModelPreference(
                    selectedChatId,
                    normalizedModelId,
                    null,
                    activeServiceTier,
                  );
                  if (modelLibrary) {
                    void refreshModelOptions({ silent: true });
                  }
                }
              : undefined,
          )
        ) {
          return false;
        }
      }
      const applySelection = () => {
        setSelectedModelId(normalizedModelId);
        setSelectedEffort(null);
        setModelModalVisible(false);
        setError(null);
        if (selectedChatId) {
          if (!modelConfig) {
            rememberChatModelPreference(selectedChatId, normalizedModelId, null, activeServiceTier);
          }
        } else if (activeAgentId && !modelLibrary) {
          const key = agentModelPreferenceKey(activeAgentId);
          const nextPreferences = {
            ...chatModelPreferencesRef.current,
            [key]: {
              modelId: normalizedModelId,
              effort: null,
              serviceTier: activeServiceTier,
              updatedAt: new Date().toISOString(),
            },
          };
          chatModelPreferencesRef.current = nextPreferences;
          void saveChatModelPreferences(nextPreferences);
        }

        if (normalizedModelId) {
          const model = modelOptions.find((entry) => entry.id === normalizedModelId) ?? null;
          if ((model?.reasoningEffort?.length ?? 0) > 0) {
            setEffortPickerModelId(normalizedModelId);
            setEffortModalVisible(true);
          }
        }
      };
      if (modelLibrary && !selectedChatId) {
        if (!normalizedModelId) {
          setError('Choose a downloaded model.');
          return false;
        }
        return selectHostDefaultModel(
          normalizedModelId,
          () => {
            applySelection();
            void refreshModelOptions();
          },
          (error) => {
            setModelModalVisible(false);
            setError(`Could not select model: ${error.message}`);
          },
        );
      }
      applySelection();
      return true;
    },
    [
      activeServiceTier,
      activeAgentId,
      applyAcpConfigOption,
      chatModelPreferencesRef,
      modelConfig,
      modelLibrary,
      modelOptions,
      rememberChatModelPreference,
      refreshModelOptions,
      saveChatModelPreferences,
      selectHostDefaultModel,
      selectedChatId,
      setEffortModalVisible,
      setEffortPickerModelId,
      setError,
      setModelModalVisible,
      setSelectedEffort,
      setSelectedModelId,
    ],
  );

  const selectPendingAgent = useCallback(
    (agentId: AgentId) => {
      if (selectedChatId) {
        return;
      }

      const rememberedSettings = agentSettings?.[agentId];
      setPendingAgentId(agentId);
      setSelectedModelId(null);
      setSelectedEffort(null);
      setSelectedServiceTier(undefined);
      setSelectedAcpModeId(null);
      setSelectedCollaborationMode(
        rememberedSettings?.collaborationMode === 'plan'
          ? rememberedSettings.collaborationMode
          : 'default',
      );
      setAgentModalVisible(false);
      setError(null);
    },
    [
      agentSettings,
      selectedChatId,
      setAgentModalVisible,
      setError,
      setPendingAgentId,
      setSelectedAcpModeId,
      setSelectedCollaborationMode,
      setSelectedEffort,
      setSelectedModelId,
      setSelectedServiceTier,
    ],
  );

  useFocusEffect(
    useCallback(() => {
      if (modelLibrary && ws.isConnected) {
        void refreshModelOptions({ silent: true });
      }
    }, [modelLibrary, refreshModelOptions, ws]),
  );

  useEffect(() => {
    if (!modelLibrary || !modelModalVisible) {
      return;
    }
    const timer = setInterval(() => {
      if (ws.isConnected) {
        void refreshModelOptions({ silent: true });
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [modelLibrary, modelModalVisible, refreshModelOptions, ws]);

  useEffect(() => {
    if (!modelLibrary && ws.isConnected) {
      void refreshModelOptions({ silent: true });
    }
    return ws.onStatus((connected) => {
      if (connected) {
        void refreshModelOptions({ silent: true });
      }
    });
  }, [modelLibrary, refreshModelOptions, ws]);

  const openCollaborationModeMenu = useCallback(() => {
    setCollaborationModeMenuVisible(true);
  }, [setCollaborationModeMenuVisible]);

  const toggleFastMode = useCallback(() => {
    if (!supportsFastMode) {
      return;
    }
    const nextServiceTier: ServiceTier | null = activeServiceTier === 'fast' ? null : 'fast';
    const enablingFastMode = nextServiceTier === 'fast';
    const nextTitle = enablingFastMode ? 'Fast mode enabled' : 'Fast mode disabled';
    setSelectedServiceTier(nextServiceTier);
    setError(null);
    setActivity({
      tone: 'complete',
      title: nextTitle,
      detail: selectedChatId ? 'Applies to the next message' : 'Applies to the next new chat',
    });
  }, [
    activeServiceTier,
    selectedChatId,
    setActivity,
    setError,
    setSelectedServiceTier,
    supportsFastMode,
  ]);

  const attachmentControlsDisabled = attachmentPickerBusy || uploadingAttachment;

  const attachmentMenuOptions = useMemo<SelectionSheetOption[]>(
    () => [
      ...(hasFailedAttachmentUploads
        ? [
            {
              key: 'retry-uploads',
              title: 'Retry failed uploads',
              description: `Retry prepared files without selecting them again. ${ATTACHMENT_MAX_LABEL} each.`,
              icon: 'refresh-outline' as const,
              disabled: attachmentControlsDisabled,
              onPress: () => {
                attachmentController.closeMenu();
                retryFailedUploads();
              },
            },
          ]
        : []),
      {
        key: 'workspace-path',
        title: 'Attach from workspace path',
        description: 'Reference a file or folder from the current repo.',
        icon: 'folder-open-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('workspace-path');
        },
      },
      {
        key: 'phone-file',
        title: 'Pick file from device',
        description: `Import a document or asset, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'document-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-file');
        },
      },
      {
        key: 'phone-image',
        title: 'Pick image from device',
        description: `Resize and compress an image, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'image-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-image');
        },
      },
      {
        key: 'phone-camera',
        title: 'Take photo',
        description: `Capture, resize, and compress a photo, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'camera-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-camera');
        },
      },
    ],
    [
      attachmentController,
      attachmentControlsDisabled,
      hasFailedAttachmentUploads,
      retryFailedUploads,
    ],
  );

  return {
    selectModel,
    selectPendingAgent,
    openCollaborationModeMenu,
    toggleFastMode,
    attachmentControlsDisabled,
    attachmentMenuOptions,
  };
}

export type MainScreenComposerControlActionsResult = ReturnType<
  typeof useMainScreenComposerControlActions
>;
